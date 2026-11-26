// Shared configuration for Insta Unfollow.
//
// SETUP (once):
//   1. Deploy payments-worker.js (the file in this folder) to Cloudflare Workers.
//      It creates Razorpay payment links, checks payment status and signs premium
//      entitlements with an Ed25519 private key that ONLY the worker holds.
//   2. Set the worker env: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, SIGN_PRIVATE_KEY
//      (hex seed), ADMIN_EMAIL (optional). Bind a KV namespace as PAYMENTS_KV.
//   3. Put your worker URL below.
//
// The public key below verifies every premium token locally: membership stored in
// chrome.storage cannot be forged by editing storage, because a valid token can only
// be signed by the worker's private key.

window.PAYMENT_API_URL = 'https://insta-unfollows.satyam-raj.workers.dev';
window.PREMIUM_PUBLIC_KEY = '1ad6e3be3cdfab04e5078b78ab5da26adb2ba93d0b8ec2d0fe23f66f073671ad';
// Owner bypass: this Google account is always premium (the person who deploys the worker).
window.PREMIUM_ADMIN_EMAIL = 'sstymrj@gmail.com';
// Manual UPI payments: the owner's real UPI ID, decoded from the QR
// he sent (img/paytm-qr.jpg). The UPI view shows that static QR image; the
// deep link below prefills the plan amount. Change the ID here and the QR
// image together — this is the single place that holds the UPI ID.
window.UPI_ID = 'paytmqr69wd1y@ptys';
window.UPI_PAYEE_NAME = 'Satyam Raj';
// PREMIUM_BY_DEFAULT: everyone is premium until you deploy the payment worker.
// Flip this to false once PAYMENT_API_URL points at a live worker and you start selling.
window.PREMIUM_BY_DEFAULT = false;

// Promotional Redeem Codes (e.g. 10 days free premium campaigns)
window.PROMO_CODES = {
  'FREE10': { days: 10, label: '10 Days Promotional Free Access' },
  'WELCOME10': { days: 10, label: '10 Days Welcome Gift' },
  'PROMO10': { days: 10, label: '10 Days Promotional Pass' },
  'INSTA10': { days: 10, label: '10 Days Free Unlimited Premium' }
};

// The background service worker cannot load this file, so it reads the worker URL from
// storage instead. Kept in sync here, once, on every extension page load.
if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
  chrome.storage.local.set({ paymentApiUrl: window.PAYMENT_API_URL });
}

(function () {
  'use strict';

  function base64urlDecode(str) {
    const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function base64urlEncode(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /** v1.<payload-b64url>.<signature-b64url> — payload is JSON {sub, plan, exp}. */
  function parseToken(token) {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') return null;
    try {
      const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(parts[1])));
      if (!payload || typeof payload.exp !== 'number') return null;
      return { payload, signature: base64urlDecode(parts[2]), message: base64urlDecode(parts[1]) };
    } catch (error) {
      return null;
    }
  }

  /**
   * Verify a premium token's signature with the embedded public key and check expiry.
   * Returns true only for a token signed by the worker AND still valid.
   */
  async function verifyPremiumToken(token) {
    const parsed = parseToken(token);
    if (!parsed) return false;
    if (Date.now() > parsed.payload.exp) return false;
    try {
      const key = await crypto.subtle.importKey(
        'raw',
        hexToBytes(window.PREMIUM_PUBLIC_KEY),
        { name: 'Ed25519' },
        false,
        ['verify']
      );
      return await crypto.subtle.verify(
        { name: 'Ed25519' },
        key,
        parsed.signature,
        parsed.message
      );
    } catch (error) {
      console.error('Premium token verification failed:', error);
      return false;
    }
  }

  function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    return bytes;
  }

  /**
   * The membership the UI should trust: verified token, or the owner email bypass.
   * Everything else is free — a hand-edited chrome.storage membership no longer counts.
   *
   * Once selling is live (PREMIUM_BY_DEFAULT=false and PAYMENT_API_URL configured), the
   * worker is the authority: grants, revokes and bans from the admin console all take
   * effect on the next membership check. If the worker cannot be reached, the locally
   * stored token is trusted as a grace period instead of locking the user out.
   */
  async function getPremiumMembership() {
    if (window.PREMIUM_BY_DEFAULT) {
      return { turu: 'premium', expiry: null, pendingProof: false };
    }
    try {
      const data = await chrome.storage.local.get(['membership', 'user_info']);
      const stored = data.membership || {};
      const userInfo = data.user_info;

      // Active local promotional code entitlement
      if (stored.turu === 'premium' && stored.grantExpiresAt && Date.now() < stored.grantExpiresAt) {
        return {
          turu: 'premium',
          expiry: new Date(stored.grantExpiresAt).toISOString(),
          pendingProof: false,
          isPromo: true,
          promoCode: stored.redeemedCode
        };
      }

      const workerLive = typeof window.PAYMENT_API_URL === 'string' &&
        !window.PAYMENT_API_URL.includes('PASTE-YOUR-WORKER');

      if (workerLive && userInfo) {
        try {
          const statusResponse = await fetch(
            window.PAYMENT_API_URL + '/status?u=' + encodeURIComponent(userInfo.id) +
            '&email=' + encodeURIComponent(userInfo.email || '')
          );
          const status = await statusResponse.json();

          if (status.banned) {
            return { turu: 'free', banned: true };
          }
          if (status.premium && status.token && await verifyPremiumToken(status.token)) {
            const parsed = parseToken(status.token);
            // A token signed for another user is not this user's premium: never store it.
            if (parsed && parsed.payload.sub === userInfo.id) {
              await chrome.storage.local.set({
                membership: {
                  uye_id: userInfo.id,
                  turu: 'premium',
                  token: status.token,
                  kayit_tarihi: new Date().toISOString()
                }
              });
              return { turu: 'premium', expiry: new Date(parsed.payload.exp).toISOString(), pendingProof: !!status.pendingProof };
            }
          }
          if (status.premium === false) {
            // The worker's answer wins: an admin revoke overrides any locally stored token.
            // pendingProof comes from /status when the worker reports it (a payment proof
            // awaiting admin approval); false when the worker does not report the field.
            return { turu: 'free', pendingProof: !!status.pendingProof };
          }
        } catch (error) {
          console.warn('Worker membership check failed, using local token:', error);
        }
      }

      if (stored.turu === 'premium' && stored.token && await verifyPremiumToken(stored.token)) {
        const parsed = parseToken(stored.token);
        // A verified token only counts when it was signed for the signed-in user.
        if (parsed && userInfo && parsed.payload.sub === userInfo.id) {
          return { turu: 'premium', expiry: new Date(parsed.payload.exp).toISOString(), pendingProof: false };
        }
      }

      const email = userInfo && userInfo.email;
      if (email && window.PREMIUM_ADMIN_EMAIL && email.toLowerCase() === window.PREMIUM_ADMIN_EMAIL.toLowerCase()) {
        return { turu: 'premium', expiry: null, pendingProof: false };
      }

      return { turu: 'free', pendingProof: false };
    } catch (error) {
      console.error('getPremiumMembership failed:', error);
      return { turu: 'free', pendingProof: false };
    }
  }

  /**
   * Shared payment-activation poller, used by both the premium modal (premium.js)
   * and the popup subscribe button (popup.js) so the two never drift apart.
   *
   * Polls GET PAYMENT_API_URL + '/status?u=...&email=...' every 4s for up to
   * ~5 minutes (75 attempts). On premium + token it stores the membership in
   * chrome.storage.local and calls onActive(); if nothing lands in time it calls
   * onTimeout(). Polling stops on success, on timeout, or when the page unloads —
   * no runaway timer is left behind. The stored token is re-verified (signature
   * and sub) by the next getPremiumMembership() call before the UI trusts it.
   */
  function pollPremiumActivation({ userId, email, onActive, onTimeout }) {
    const apiUrl = window.PAYMENT_API_URL;
    const maxAttempts = 75;
    const intervalMs = 4000;
    let attempts = 0;
    let stopped = false;
    const stop = () => { stopped = true; };
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('pagehide', stop, { once: true });
    }
    const check = async () => {
      if (stopped) return;
      attempts++;
      try {
        const statusResponse = await fetch(
          apiUrl + '/status?u=' + encodeURIComponent(userId || '') +
          '&email=' + encodeURIComponent(email || '')
        );
        const status = await statusResponse.json();
        if (status.premium && status.token) {
          stopped = true;
          try {
            await chrome.storage.local.set({
              membership: {
                uye_id: userId,
                turu: 'premium',
                token: status.token,
                kayit_tarihi: new Date().toISOString()
              }
            });
          } catch (error) {
            console.warn('Could not store premium membership:', error);
          }
          if (typeof onActive === 'function') onActive();
          return;
        }
      } catch (error) {
        console.error('Payment status check failed:', error);
      }
      if (stopped) return;
      if (attempts >= maxAttempts) {
        stopped = true;
        if (typeof onTimeout === 'function') onTimeout();
        return;
      }
      setTimeout(check, intervalMs);
    };
    check();
    return stop;
  }

  // ---------------------------------------------------------------------------
  // Manual payments (UPI): the buyer pays outside the extension and
  // submits a screenshot + UTR as proof; an admin approves it from the console
  // and /status then returns premium. Nothing here promises automatic
  // activation for a manual payment, and Razorpay is never offered: its code
  // stays dormant until keys exist, and manual UPI is the only option.
  // ---------------------------------------------------------------------------

  // Premium plans (INR) — the single source of truth for every price in the
  // extension. No other file may hardcode a plan price: the modal, the popup
  // and the UPI/proof builders all read from here.
  //   key: plan key sent to /submit-proof and named in the UPI note.
  //   months/days: duration (days is the token lifetime the worker grants).
  //   price: what the buyer pays. strike: crossed-out price (months x the
  //     1-month price), shown whenever it is above the price; null only for
  //     1mo, where strike == price. save: rupees saved vs months x the
  //     1-month price; 1mo carries 0 and renders as "No discount". Every
  //     longer plan genuinely saves vs buying 1-month plans.
  //   perMonth: rounded per-month rate shown as "₹X/mo". (Known quirk, left
  //     as-is: 9mo per-month ₹44 sits slightly above 6mo ₹42.)
  window.PREMIUM_PLANS = [
    { key: '1mo', months: 1, days: 30, price: 49, strike: null, save: 0, perMonth: 49, label: '1 month' },
    { key: '3mo', months: 3, days: 90, price: 129, strike: 147, save: 18, perMonth: 43, label: '3 months' },
    { key: '6mo', months: 6, days: 180, price: 249, strike: 294, save: 45, perMonth: 42, label: '6 months' },
    { key: '9mo', months: 9, days: 270, price: 399, strike: 441, save: 42, perMonth: 44, label: '9 months' },
    { key: '12mo', months: 12, days: 365, price: 499, strike: 588, save: 89, perMonth: 42, label: '12 months' }
  ];

  // Plan lookup by key; unknown keys fall back to the 1-month plan.
  function getPremiumPlan(plan) {
    var found = null;
    for (var i = 0; i < window.PREMIUM_PLANS.length; i++) {
      if (window.PREMIUM_PLANS[i].key === plan) { found = window.PREMIUM_PLANS[i]; break; }
    }
    return found || window.PREMIUM_PLANS[0];
  }

  function upiAmountForPlan(plan) {
    return getPremiumPlan(plan).price;
  }

  // Duration label for the UPI transaction note, e.g. "1 Month" / "3 Months".
  function upiPlanLabel(plan) {
    var months = getPremiumPlan(plan).months;
    return months + (months === 1 ? ' Month' : ' Months');
  }

  function isUpiConfigured() {
    return typeof window.UPI_ID === 'string' && window.UPI_ID.trim() !== '';
  }

  /**
   * upi://pay?pa=<UPI_ID>&pn=Satyam%20Raj&am=<plan price>&cu=INR
   *   &tn=Insta%20Unfollow%20Premium%20<1 Month|3 Months|...>
   * Amount is a plain integer taken from the shared plan definition; the
   * note names the plan duration and is URL-encoded.
   */
  function buildUpiPaymentUri(plan) {
    var amount = upiAmountForPlan(plan);
    var payee = window.UPI_PAYEE_NAME || 'Satyam Raj';
    return 'upi://pay?pa=' + encodeURIComponent(window.UPI_ID || '') +
      '&pn=' + encodeURIComponent(payee) +
      '&am=' + amount +
      '&cu=INR&tn=' + encodeURIComponent('Insta Unfollow Premium ' + upiPlanLabel(plan));
  }

  /** Stored Google access token, used as the Bearer token for worker calls. */
  async function getGoogleAuthToken() {
    try {
      var data = await chrome.storage.local.get(['auth_token']);
      return (data && data.auth_token) || '';
    } catch (error) {
      return '';
    }
  }

  var cachedPaymentMethods = null;

  /**
   * Which manual methods the worker reports as live: GET /payment-methods.
   * Cached in memory for the page lifetime. On any failure (worker down, or
   * the endpoint not deployed yet) the UI still offers UPI so a buyer is
   * never left with no way to pay. UPI is the only method: fixed payment
   * links are not offered (their short validity makes them unusable), and
   * Razorpay is forced false here — manual UPI only.
   */
  async function getPaymentMethods() {
    if (cachedPaymentMethods) return cachedPaymentMethods;
    var fallback = { upi: true, razorpay: false };
    try {
      var response = await fetch(window.PAYMENT_API_URL + '/payment-methods');
      if (!response.ok) throw new Error('payment-methods HTTP ' + response.status);
      var data = await response.json();
      cachedPaymentMethods = {
        upi: !!data.upi,
        razorpay: false
      };
    } catch (error) {
      console.warn('Could not load payment methods, offering UPI only:', error);
      cachedPaymentMethods = fallback;
    }
    return cachedPaymentMethods;
  }

  /**
   * Submit a manual-payment proof for admin review. Throws an Error carrying
   * the worker's message on failure, with friendly text for the two cases
   * the UI must word itself: 409 (a proof is already under review) and
   * 413 (screenshot too large).
   */
  async function submitPaymentProof(opts) {
    opts = opts || {};
    var token = await getGoogleAuthToken();
    if (!token) {
      throw new Error('Please sign in with Google again and try once more.');
    }
    var response;
    try {
      response = await fetch(window.PAYMENT_API_URL + '/submit-proof', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token
        },
        body: JSON.stringify({
          userId: opts.userId || '',
          plan: opts.plan || '1mo',
          method: opts.method || 'upi',
          utr: opts.utr || '',
          screenshot: opts.screenshotDataUrl || ''
        })
      });
    } catch (error) {
      console.error('submitPaymentProof failed:', error);
      throw new Error('Could not reach the payment server — check your connection and try again.');
    }
    var payload = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      if (response.status === 409) {
        throw new Error('You already have a payment under review — we\'ll activate Premium once it\'s approved.');
      }
      if (response.status === 413) {
        throw new Error('That screenshot is too large — please use a smaller or cropped screenshot and try again.');
      }
      throw new Error(payload.error || 'Payment proof could not be submitted — please try again.');
    }
    return payload;
  }

  /**
   * Downscale a payment screenshot to max 1024px on the longest side (never
   * upscale) and export it as JPEG quality 0.75. Throws when the result is
   * still over 500 KB, telling the user to use a smaller/cropped screenshot.
   */
  function compressProofScreenshot(file) {
    return new Promise(function (resolve, reject) {
      if (!file || typeof file.type !== 'string' || file.type.indexOf('image/') !== 0) {
        reject(new Error('Please attach an image file as your payment screenshot.'));
        return;
      }
      var reader = new FileReader();
      reader.onerror = function () {
        reject(new Error('Could not read that screenshot — please try a different image.'));
      };
      reader.onload = function () {
        var img = new Image();
        img.onerror = function () {
          reject(new Error('Could not read that screenshot — please try a different image.'));
        };
        img.onload = function () {
          var scale = Math.min(1, 1024 / Math.max(img.width, img.height));
          var width = Math.max(1, Math.round(img.width * scale));
          var height = Math.max(1, Math.round(img.height * scale));
          var canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          var ctx = canvas.getContext('2d');
          if (!ctx) {
            reject(new Error('Could not process that screenshot — please try a different image.'));
            return;
          }
          ctx.drawImage(img, 0, 0, width, height);
          var dataUrl = canvas.toDataURL('image/jpeg', 0.75);
          var base64 = dataUrl.split(',')[1] || '';
          var bytes = Math.ceil(base64.length * 3 / 4);
          if (bytes > 500 * 1024) {
            reject(new Error('That screenshot is still over 500 KB after compression — please use a smaller or cropped screenshot and try again.'));
            return;
          }
          resolve(dataUrl);
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // --- Shared payment UI ---------------------------------------------------
  // The premium modal (premium.js) and the popup (popup.js) render the same
  // method picker, UPI view and proof form from these builders so the two
  // never drift apart. Elements carry inline styles: the popup does not load
  // premium-modal.css, so nothing here may depend on it.

  var UNDER_REVIEW_TEXT = 'Payment under review — Premium activates once approved (usually within a day)';
  window.PREMIUM_UNDER_REVIEW_TEXT = UNDER_REVIEW_TEXT;

  function el(tag, text, style) {
    var node = document.createElement(tag);
    if (text) node.textContent = text;
    if (style) node.style.cssText = style;
    return node;
  }

  /**
   * Populate a `<select class="pro-plan-select">` using the modern Customizable Select
   * structure (`<button><selectedcontent></selectedcontent></button>` + rich `<option>` rows)
   * with natural plain-text phrasing so older browsers that strip inner HTML still render
   * crystal-clear option text.
   */
  function populateProPlanSelect(selectEl, selectedKey) {
    if (!selectEl || !Array.isArray(window.PREMIUM_PLANS)) return;
    selectEl.innerHTML = '';

    var supportsBaseSelect = typeof CSS !== 'undefined' &&
      typeof CSS.supports === 'function' &&
      CSS.supports('appearance', 'base-select');

    if (supportsBaseSelect) {
      var triggerBtn = document.createElement('button');
      var selectedContent = document.createElement('selectedcontent');
      triggerBtn.appendChild(selectedContent);
      selectEl.appendChild(triggerBtn);
    }

    window.PREMIUM_PLANS.forEach(function (plan) {
      var opt = document.createElement('option');
      opt.value = plan.key;
      if (plan.key === selectedKey) opt.selected = true;

      var capLabel = plan.label.charAt(0).toUpperCase() + plan.label.slice(1);

      if (!supportsBaseSelect) {
        var tagTxt = plan.key === '6mo' ? ' ★ Popular' : (plan.key === '12mo' ? ' ★ Best Value' : '');
        var saveTxt = plan.save > 0 ? ' · Save ₹' + plan.save : '';
        opt.textContent = capLabel + tagTxt + ' — ₹' + plan.price + ' (₹' + plan.perMonth + '/mo' + saveTxt + ')';
        selectEl.appendChild(opt);
        return;
      }

      var left = el('span', '', '');
      left.className = 'opt-left';

      var titleRow = el('span', '', '');
      titleRow.className = 'opt-title-row';

      var dur = el('span', capLabel, '');
      dur.className = 'opt-duration';
      titleRow.appendChild(dur);

      if (plan.key === '6mo') {
        var popSep = el('span', ' · ', '');
        popSep.className = 'visually-hidden';
        titleRow.appendChild(popSep);
        var popBadge = el('span', 'POPULAR', '');
        popBadge.className = 'opt-tag popular';
        titleRow.appendChild(popBadge);
      } else if (plan.key === '12mo') {
        var bestSep = el('span', ' · ', '');
        bestSep.className = 'visually-hidden';
        titleRow.appendChild(bestSep);
        var bestBadge = el('span', 'BEST VALUE', '');
        bestBadge.className = 'opt-tag best';
        titleRow.appendChild(bestBadge);
      }

      var subSep = el('span', ' — ', '');
      subSep.className = 'visually-hidden';
      var sub = el('span', '₹' + plan.perMonth + '/mo effective', '');
      sub.className = 'opt-sub';

      left.appendChild(titleRow);
      left.appendChild(subSep);
      left.appendChild(sub);

      var right = el('span', '', '');
      right.className = 'opt-right';

      var priceSep = el('span', ' · ', '');
      priceSep.className = 'visually-hidden';
      right.appendChild(priceSep);

      if (plan.save > 0) {
        var saveChip = el('span', 'Save ₹' + plan.save, '');
        saveChip.className = 'opt-save';
        right.appendChild(saveChip);
        var sSep = el('span', ' · ', '');
        sSep.className = 'visually-hidden';
        right.appendChild(sSep);
      }

      var priceSpan = el('span', '₹' + plan.price, '');
      priceSpan.className = 'opt-price';
      right.appendChild(priceSpan);

      opt.appendChild(left);
      opt.appendChild(right);
      selectEl.appendChild(opt);
    });
  }

  function createUnderReviewNotice() {
    var box = el('div', '', '');
    box.className = 'pro-review-notice';
    var badge = el('div', '⏳ VERIFICATION IN PROGRESS', '');
    badge.className = 'pro-review-kicker';
    var msg = el('div', UNDER_REVIEW_TEXT, '');
    msg.className = 'pro-review-body';
    box.appendChild(badge);
    box.appendChild(msg);
    return box;
  }

  /**
   * Method picker for one plan (UPI dark-glass studio card).
   */
  function createPaymentMethodPicker(opts) {
    opts = opts || {};
    var plan = opts.plan || '1mo';
    var planObj = getPremiumPlan(plan);
    var methods = opts.methods || { upi: true, razorpay: false };
    var container = el('div', '', '');
    container.className = 'premium-payment-methods pro-checkout-box';

    var summary = el('div', '', '');
    summary.className = 'pro-checkout-summary';
    var sumLeft = el('div', '', '');
    var sumKicker = el('div', 'Selected Plan', '');
    sumKicker.className = 'pro-sum-kicker';
    var sumTitle = el('div', 'Pro Pass · ' + upiPlanLabel(plan), '');
    sumTitle.className = 'pro-sum-title';
    sumLeft.appendChild(sumKicker);
    sumLeft.appendChild(sumTitle);

    var sumRight = el('div', '', 'text-align:right;');
    var sumPrice = el('div', '₹' + upiAmountForPlan(plan), '');
    sumPrice.className = 'pro-sum-price';
    sumRight.appendChild(sumPrice);
    if (planObj.save > 0) {
      var sumSave = el('div', 'Saving ₹' + planObj.save, '');
      sumSave.className = 'pro-sum-save';
      sumRight.appendChild(sumSave);
    }
    summary.appendChild(sumLeft);
    summary.appendChild(sumRight);
    container.appendChild(summary);

    var usable = 0;
    if (methods.upi) {
      var upiBtn = el('button', '', '');
      upiBtn.type = 'button';
      upiBtn.className = 'pro-method-upi-btn';
      var upiLabel = el('span', 'Pay ₹' + upiAmountForPlan(plan) + ' via Instant UPI QR', '');
      var upiSub = el('span', 'GPay · PhonePe · Paytm · BHIM →', 'font-size:11.5px;font-weight:600;opacity:0.9;');
      upiBtn.appendChild(upiLabel);
      upiBtn.appendChild(upiSub);
      upiBtn.addEventListener('click', function () { opts.onPick && opts.onPick('upi'); });
      container.appendChild(upiBtn);
      usable++;
    }
    if (usable === 0) {
      container.appendChild(el('div', 'Payments are not available yet — please check back soon.',
        'color:#94a3b8;font-size:13px;font-weight:500;padding:8px 2px;'));
    }
    return container;
  }

  /**
   * UPI payment view for one plan: dark-glass summary, 1-click UPI ID copy pill,
   * crisp white-framed QR pad for camera reliability, and deep-link button.
   */
  function createUpiPaymentView(plan) {
    plan = plan || '1mo';
    var amount = upiAmountForPlan(plan);
    var container = el('div', '', '');
    container.className = 'premium-upi-view pro-upi-card';

    var stepTag = el('div', 'STEP 1 · COMPLETE UPI TRANSFER', '');
    stepTag.className = 'pro-step-kicker';
    container.appendChild(stepTag);

    var head = el('div', 'Pay ₹' + amount + ' for Pro (' + upiPlanLabel(plan) + ')', '');
    head.className = 'pro-upi-headline';
    container.appendChild(head);

    var qrFrame = el('div', '', '');
    qrFrame.className = 'pro-qr-frame';
    var qrImg = document.createElement('img');
    qrImg.src = 'img/paytm-qr.jpg';
    qrImg.alt = 'Pay with UPI — scan with any UPI app';
    qrFrame.appendChild(qrImg);
    container.appendChild(qrFrame);

    var amountHint = el('div',
      'Scan with GPay, PhonePe, Paytm, or BHIM and enter ₹' + amount + ' manually (or tap Open UPI App below to prefill ₹' + amount + ').',
      '');
    amountHint.className = 'pro-upi-hint';
    container.appendChild(amountHint);

    var idRow = el('div', '', '');
    idRow.className = 'pro-upi-id-bar';
    var idText = el('span', window.UPI_ID, '');
    idText.className = 'pro-upi-id-code';
    var copyBtn = el('button', 'Copy UPI ID', '');
    copyBtn.type = 'button';
    copyBtn.className = 'pro-upi-copy-btn';
    copyBtn.addEventListener('click', function () {
      var done = function () {
        copyBtn.textContent = '✓ Copied';
        setTimeout(function () { copyBtn.textContent = 'Copy UPI ID'; }, 2000);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(window.UPI_ID).then(done, function () { copyBtn.textContent = 'Failed'; });
      } else {
        copyBtn.textContent = 'Failed';
      }
    });
    idRow.appendChild(idText);
    idRow.appendChild(copyBtn);
    container.appendChild(idRow);

    var openLink = el('a', 'Open UPI App (₹' + amount + ' prefilled) ↗', '');
    openLink.className = 'pro-upi-deeplink';
    openLink.href = buildUpiPaymentUri(plan);
    openLink.target = '_blank';
    openLink.rel = 'noopener';
    container.appendChild(openLink);

    return container;
  }

  /**
   * Proof-submission form with styled screenshot dropzone & UTR input.
   */
  function createProofForm(opts) {
    opts = opts || {};
    var plan = opts.plan || '1mo';
    var method = opts.method || 'upi';
    var planInfo = getPremiumPlan(plan);
    var form = el('div', '', '');
    form.className = 'premium-proof-form pro-proof-card';

    var stepTag = el('div', 'STEP 2 · UPLOAD PAYMENT SCREENSHOT', '');
    stepTag.className = 'pro-step-kicker';
    form.appendChild(stepTag);

    var subInfo = el('div', 'Verifying ' + planInfo.label + ' Pro Pass (₹' + planInfo.price + ' via UPI)', '');
    subInfo.className = 'pro-proof-sub';
    form.appendChild(subInfo);

    var utrInput = el('input', '', '');
    utrInput.type = 'text';
    utrInput.className = 'pro-proof-input';
    utrInput.placeholder = '12-digit UTR / UPI Ref ID (optional, speeds review)';
    utrInput.setAttribute('aria-label', 'UTR or transaction ID (optional)');
    form.appendChild(utrInput);

    var dropLabel = document.createElement('label');
    dropLabel.className = 'pro-upload-dropzone';
    var fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.required = true;
    fileInput.className = 'pro-file-hidden';
    fileInput.setAttribute('aria-label', 'Payment screenshot (required)');

    var dropTitle = el('span', '📎 Click to attach payment screenshot (Required)', '');
    dropTitle.className = 'pro-upload-title';
    var dropHint = el('span', 'PNG or JPG · Compressed locally on your device', '');
    dropHint.className = 'pro-upload-hint';

    fileInput.addEventListener('change', function () {
      var f = fileInput.files && fileInput.files[0];
      if (f) {
        dropTitle.textContent = '✓ ' + f.name;
        dropLabel.classList.add('has-file');
      } else {
        dropTitle.textContent = '📎 Click to attach payment screenshot (Required)';
        dropLabel.classList.remove('has-file');
      }
    });

    dropLabel.appendChild(fileInput);
    dropLabel.appendChild(dropTitle);
    dropLabel.appendChild(dropHint);
    form.appendChild(dropLabel);

    var errorEl = el('div', '', 'display:none;');
    errorEl.className = 'pro-proof-error';
    form.appendChild(errorEl);

    var submitBtn = el('button', 'Submit Payment Proof →', '');
    submitBtn.type = 'button';
    submitBtn.className = 'pro-proof-submit-btn';
    submitBtn.addEventListener('click', function () {
      var showError = function (message) {
        errorEl.textContent = message;
        errorEl.style.display = 'block';
      };
      errorEl.style.display = 'none';
      var file = fileInput.files && fileInput.files[0];
      if (!file) {
        showError('Please attach your payment screenshot first.');
        return;
      }
      if (file.type.indexOf('image/') !== 0) {
        showError('Please attach an image file (PNG or JPG) as your payment screenshot.');
        return;
      }
      submitBtn.disabled = true;
      submitBtn.textContent = 'Encrypting & submitting…';
      compressProofScreenshot(file).then(function (screenshotDataUrl) {
        return submitPaymentProof({
          userId: opts.userId || '',
          plan: plan,
          method: method,
          utr: utrInput.value.trim(),
          screenshotDataUrl: screenshotDataUrl
        });
      }).then(function () {
        form.innerHTML = '';
        form.appendChild(createUnderReviewNotice());
        if (typeof opts.onSuccess === 'function') opts.onSuccess();
      }).catch(function (error) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Payment Proof →';
        showError((error && error.message) || 'Payment proof could not be submitted — please try again.');
      });
    });
    form.appendChild(submitBtn);
    return form;
  }

  window.redeemPromoCode = async function (code) {
    if (!code || typeof code !== 'string') {
      return { success: false, error: 'Please enter a valid promo code.' };
    }
    const cleanCode = code.trim().toUpperCase();

    try {
      const data = await chrome.storage.local.get(['redeemed_codes', 'user_info', 'membership', 'admin_promos']);
      let promo = (window.PROMO_CODES || {})[cleanCode];
      if (!promo && Array.isArray(data.admin_promos)) {
        const found = data.admin_promos.find(x => x.code === cleanCode);
        if (found) promo = { days: found.days, label: found.note || `${found.days} Days Free Access` };
      }

      if (!promo) {
        return { success: false, error: 'Invalid or unrecognized promo code. Please check and try again.' };
      }
      const redeemedList = Array.isArray(data.redeemed_codes) ? data.redeemed_codes : [];
      if (redeemedList.includes(cleanCode)) {
        return { success: false, error: 'You have already redeemed this promo code on this device.' };
      }

      const days = promo.days || 10;
      const expiresAt = Date.now() + days * 86400000;
      const userInfo = data.user_info;

      const newMembership = {
        uye_id: (userInfo && userInfo.id) || 'local_user',
        turu: 'premium',
        grantExpiresAt: expiresAt,
        redeemedCode: cleanCode,
        kayit_tarihi: new Date().toISOString()
      };

      await chrome.storage.local.set({
        redeemed_codes: [...redeemedList, cleanCode],
        membership: newMembership
      });

      return {
        success: true,
        code: cleanCode,
        days: days,
        expiresAt: expiresAt,
        message: `🎉 Success! ${promo.label || (days + ' Days Premium')} has been activated!`
      };
    } catch (e) {
      return { success: false, error: 'Failed to apply promo code: ' + (e.message || String(e)) };
    }
  };

  window.verifyPremiumToken = verifyPremiumToken;
  window.getPremiumMembership = getPremiumMembership;
  window.pollPremiumActivation = pollPremiumActivation;
  window.getPremiumPlan = getPremiumPlan;
  window.getPaymentMethods = getPaymentMethods;
  window.submitPaymentProof = submitPaymentProof;
  window.compressProofScreenshot = compressProofScreenshot;
  window.upiAmountForPlan = upiAmountForPlan;
  window.buildUpiPaymentUri = buildUpiPaymentUri;
  window.isUpiConfigured = isUpiConfigured;
  window.getGoogleAuthToken = getGoogleAuthToken;
  window.createPaymentMethodPicker = createPaymentMethodPicker;
  window.createUpiPaymentView = createUpiPaymentView;
  window.createProofForm = createProofForm;
  window.createUnderReviewNotice = createUnderReviewNotice;
  window.populateProPlanSelect = populateProPlanSelect;
})();