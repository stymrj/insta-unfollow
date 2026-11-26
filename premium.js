/**
 * Premium modal: pricing, plan choice and checkout.
 *
 * Lifted out of analyzer.js so the bot scan can open the same modal instead of carrying a second
 * copy of the payment UI. Two copies of a checkout is how one of them quietly goes stale and starts
 * showing the wrong price.
 *
 * Both pages include the same markup block and load this file before their own script.
 */

function openPremiumModal() {
    const premiumModal = document.getElementById('premiumModal');
    if (premiumModal) {
        premiumModal.classList.add('active');
        document.body.style.overflow = 'hidden';

        // Fetch and update prices from API
        fetchPremiumPrices();

        // Plan dropdown defaults to 6-month popular plan on open.
        wireModalPlanOptions();
        wirePromoRedeem();
        setModalSelectedPlan(modalSelectedPlanKey || '6mo');

        // Update pricing and subscription button visibility
        updatePremiumModalContent();

        // A proof under review replaces the Subscribe buttons (and no poll
        // runs — polling a 5-minute wait for an admin decision is pointless).
        // Otherwise the modal resumes its normal state and watches for an
        // admin approval landing while it is open (see below).
        refreshModalPaymentState();
    }
}

function closePremiumModal() {
    const premiumModal = document.getElementById('premiumModal');
    if (premiumModal) {
        premiumModal.classList.remove('active');
        document.body.style.overflow = '';
    }
    stopModalActivationPoll();
}

// The poll started by refreshModalPaymentState while the modal is open; at
// most one runs at a time, and closing the modal stops it.
let modalPollStop = null;

function stopModalActivationPoll() {
    if (typeof modalPollStop === 'function') {
        try { modalPollStop(); } catch (error) { /* already stopped */ }
    }
    modalPollStop = null;
}

function getModalPaymentStep() {
    return document.getElementById('premiumPaymentStep');
}

function setModalSubscribeButtonsVisible(visible) {
    document.querySelectorAll('.premium-card-subscribe-button').forEach((button) => {
        button.style.display = visible ? '' : 'none';
    });
}

function showModalPaymentStep() {
    const step = getModalPaymentStep();
    if (step) {
        step.style.display = 'block';
        step.innerHTML = '';
    }
    return step;
}

function hideModalPaymentStep() {
    const step = getModalPaymentStep();
    if (step) {
        step.style.display = 'none';
        step.innerHTML = '';
    }
}

function showModalUnderReview() {
    setModalSubscribeButtonsVisible(false);
    const step = showModalPaymentStep();
    if (step && typeof window.createUnderReviewNotice === 'function') {
        step.appendChild(window.createUnderReviewNotice());
    }
}

/**
 * Decides the modal's payment state on open: premium members and pending
 * proofs never see Subscribe buttons; a free user with nothing pending gets
 * the normal pricing view, and the shared poll watches for an admin approval
 * landing while the modal stays open (it fires onActive -> Premium active).
 */
async function refreshModalPaymentState() {
    if (typeof getPremiumMembership !== 'function') return;
    stopModalActivationPoll();
    let membership;
    try {
        membership = await getPremiumMembership();
    } catch (error) {
        console.error('refreshModalPaymentState failed:', error);
        return;
    }
    if (!membership || membership.turu === 'premium') {
        setModalSubscribeButtonsVisible(false);
        hideModalPaymentStep();
        return;
    }
    if (membership.pendingProof) {
        showModalUnderReview();
        return;
    }
    setModalSubscribeButtonsVisible(true);
    hideModalPaymentStep();
    if (typeof window.pollPremiumActivation !== 'function') return;
    try {
        const data = await chrome.storage.local.get(['user_info']);
        const userId = (data.user_info && data.user_info.id) || '';
        const email = (data.user_info && data.user_info.email) || '';
        modalPollStop = window.pollPremiumActivation({
            userId,
            email,
            onActive: () => {
                setModalSubscribeButtonsVisible(false);
                const step = showModalPaymentStep();
                if (step) step.textContent = '✓ Premium active!';
                setTimeout(() => {
                    closePremiumModal();
                    location.reload();
                }, 900);
            },
            onTimeout: () => { /* nothing landed; the user just keeps browsing */ }
        });
    } catch (error) {
        console.error('Modal activation poll failed to start:', error);
    }
}

function initializePremiumModal() {
    // Fetch prices from API
    fetchPremiumPrices();
    wireModalPlanOptions();
}

let modalSelectedPlanKey = '6mo';

function setModalSelectedPlan(planKey) {
    if (!Array.isArray(window.PREMIUM_PLANS) || !window.PREMIUM_PLANS.length) return '1mo';
    const plan = typeof window.getPremiumPlan === 'function'
        ? window.getPremiumPlan(planKey) : window.PREMIUM_PLANS[0];
    modalSelectedPlanKey = plan.key;

    const selectEl = document.getElementById('modalPlanSelect');
    if (selectEl && selectEl.value !== plan.key) {
        selectEl.value = plan.key;
    }

    // Update live Pro Price Header in modal
    const livePrice = document.getElementById('modalLivePrice');
    const liveStrike = document.getElementById('modalLiveStrike');
    const liveCycle = document.getElementById('modalLiveCycle');
    const liveSave = document.getElementById('modalLiveSave');
    const liveEff = document.getElementById('modalLivePerMonth');

    if (livePrice) livePrice.textContent = '₹' + plan.price;
    if (liveStrike) {
        if (plan.strike != null && plan.strike > plan.price) {
            liveStrike.textContent = '₹' + plan.strike;
            liveStrike.style.display = 'inline';
        } else {
            liveStrike.style.display = 'none';
        }
    }
    if (liveCycle) liveCycle.textContent = '/ ' + plan.label;
    if (liveSave) {
        liveSave.textContent = plan.save > 0
            ? ((plan.key === '12mo' ? 'BEST VALUE · SAVE ₹' : 'SAVE ₹') + plan.save)
            : 'FLEXIBLE STARTER';
        liveSave.classList.toggle('muted', !(plan.save > 0));
    }
    if (liveEff) {
        liveEff.textContent = '₹' + plan.perMonth + '/mo effective · One-time pass, no auto-debit';
    }

    const button = document.getElementById('premiumSubscribeButton');
    if (button) {
        button.setAttribute('data-plan', plan.key);
        button.textContent = 'Unlock Pro — ' + plan.label + ' · ₹' + plan.price + ' →';
    }
    return plan.key;
}

let modalPlanOptionsWired = false;

function wireModalPlanOptions() {
    const selectEl = document.getElementById('modalPlanSelect');
    if (!selectEl || !Array.isArray(window.PREMIUM_PLANS)) return;
    if (typeof window.populateProPlanSelect === 'function' && !selectEl.options.length) {
        window.populateProPlanSelect(selectEl, modalSelectedPlanKey);
    }
    if (!modalPlanOptionsWired) {
        modalPlanOptionsWired = true;
        selectEl.addEventListener('change', () => {
            setModalSelectedPlan(selectEl.value);
        });
    }
}

function fetchPremiumPrices() {
    if (!Array.isArray(window.PREMIUM_PLANS)) return;
    const selectEl = document.getElementById('modalPlanSelect');
    if (selectEl && typeof window.populateProPlanSelect === 'function') {
        window.populateProPlanSelect(selectEl, modalSelectedPlanKey);
    }
    setModalSelectedPlan(modalSelectedPlanKey);
}

function updatePremiumModalContent() {
    // Modal content is now handled by individual card buttons
    // No need for separate subscribe section
}

  const t = (key) => (typeof getMessage === 'function' ? getMessage(key) : '') || '';

  // Manual-payment checkout: plan -> method picker -> UPI view
  // -> proof-submission form. Nothing here promises automatic activation for
  // a manual payment: premium activates only once an admin approves the
  // submitted proof.
  function handlePremiumSubscribe(planType = '1mo') {
  // Unknown or legacy plan keys fall back to the 1-month plan.
  planType = typeof window.getPremiumPlan === 'function'
    ? window.getPremiumPlan(planType).key : (planType || '1mo');
  (async () => {
    const step = getModalPaymentStep();
    try {
      const already = await getPremiumMembership();
      if (already.turu === 'premium') {
        closePremiumModal();
        return;
      }
      if (already.pendingProof) {
        // A proof is already under review: show that state instead of
        // Subscribe buttons, and do not start a poll for it.
        showModalUnderReview();
        return;
      }

      const data = await chrome.storage.local.get(['user_info']);
      const userId = (data.user_info && data.user_info.id) || '';
      const email = (data.user_info && data.user_info.email) || '';

      const apiUrl = window.PAYMENT_API_URL;
      if (!apiUrl || typeof apiUrl !== 'string' || apiUrl.includes('PASTE-YOUR-WORKER')) {
        const stepEl = showModalPaymentStep();
        if (stepEl) stepEl.textContent = 'Payment is not configured yet.';
        return;
      }

      showModalPaymentStep();
      if (step) step.textContent = 'Loading payment methods…';
      const methods = typeof window.getPaymentMethods === 'function'
        ? await window.getPaymentMethods()
        : { upi: true, razorpay: false };

      const renderPicker = () => {
        const stepEl = showModalPaymentStep();
        if (!stepEl || typeof window.createPaymentMethodPicker !== 'function') return;
        stepEl.appendChild(window.createPaymentMethodPicker({
          plan: planType,
          methods,
          onPick: (method) => onMethodPicked(method)
        }));
        const backBtn = document.createElement('button');
        backBtn.type = 'button';
        backBtn.className = 'pro-back-btn';
        backBtn.textContent = '← Change plan';
        backBtn.addEventListener('click', () => {
          hideModalPaymentStep();
          setModalSubscribeButtonsVisible(true);
        });
        stepEl.appendChild(backBtn);
        stepEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      };

      const showProofForm = (method) => {
        const stepEl = getModalPaymentStep();
        if (!stepEl || typeof window.createProofForm !== 'function') return;
        stepEl.appendChild(window.createProofForm({
          plan: planType,
          method,
          userId,
          onSuccess: () => {
            // Proof accepted for review: hide the Subscribe buttons so the
            // user cannot start a second checkout for the same plan.
            setModalSubscribeButtonsVisible(false);
          }
        }));
      };

      const onMethodPicked = async (method) => {
        if (method === 'upi') {
          const stepEl = showModalPaymentStep();
          if (!stepEl) return;
          stepEl.appendChild(window.createUpiPaymentView(planType));
          showProofForm('upi');
          return;
        }
      };

      renderPicker();
    } catch (error) {
      console.error('handlePremiumSubscribe failed:', error);
      const stepEl = showModalPaymentStep();
      if (stepEl) {
        stepEl.textContent = t('premiumPaymentError') || 'Payment failed — try again';
      }
    }
  })();
}

function wirePromoRedeem() {
    const btn = document.getElementById('promoRedeemBtn');
    const input = document.getElementById('promoCodeInput');
    const msg = document.getElementById('promoCodeMsg');
    if (!btn || !input || btn.dataset.wired === 'true') return;
    btn.dataset.wired = 'true';

    const handleRedeem = async () => {
        const code = input.value.trim();
        if (!code) {
            if (msg) {
                msg.textContent = 'Please enter a code to redeem.';
                msg.className = 'promo-code-msg error';
                msg.style.display = 'block';
            }
            return;
        }

        btn.disabled = true;
        btn.textContent = 'Redeeming…';
        if (msg) msg.style.display = 'none';

        if (typeof window.redeemPromoCode === 'function') {
            const res = await window.redeemPromoCode(code);
            btn.disabled = false;
            btn.textContent = 'Redeem Code';
            if (msg) {
                msg.textContent = res.message || res.error;
                msg.className = 'promo-code-msg ' + (res.success ? 'success' : 'error');
                msg.style.display = 'block';
            }
            if (res.success) {
                input.value = '';
                setTimeout(() => {
                    location.reload();
                }, 1500);
            }
        }
    };

    btn.addEventListener('click', handleRedeem);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleRedeem();
        }
    });
}

document.addEventListener('DOMContentLoaded', () => {
    wirePromoRedeem();
});
