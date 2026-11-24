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

        // Plan options default to the 1-month plan on every open.
        wireModalPlanOptions();
        wirePromoRedeem();
        setModalSelectedPlan('1mo');

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

// The selected plan option drives the single subscribe button below the
// options: its data-plan (read by the page's click handler) and its label
// always match the selected option. Default selected plan: 1 month.
function setModalSelectedPlan(planKey) {
    if (!Array.isArray(window.PREMIUM_PLANS) || !window.PREMIUM_PLANS.length) return '1mo';
    const plan = typeof window.getPremiumPlan === 'function'
        ? window.getPremiumPlan(planKey) : window.PREMIUM_PLANS[0];
    document.querySelectorAll('.premium-plan-option').forEach((option) => {
        const selected = option.getAttribute('data-plan') === plan.key;
        option.classList.toggle('selected', selected);
        option.setAttribute('aria-checked', selected ? 'true' : 'false');
    });
    const button = document.getElementById('premiumSubscribeButton');
    if (button) {
        button.setAttribute('data-plan', plan.key);
        button.textContent = 'Continue — ' + plan.label + ' · ₹' + plan.price;
    }
    return plan.key;
}

let modalPlanOptionsWired = false;

function wireModalPlanOptions() {
    if (modalPlanOptionsWired) return;
    const options = document.getElementById('premiumPlanOptions');
    if (!options) return;
    modalPlanOptionsWired = true;
    options.addEventListener('click', (event) => {
        const option = event.target.closest('.premium-plan-option');
        if (option) setModalSelectedPlan(option.getAttribute('data-plan'));
    });
}

function fetchPremiumPrices() {
    // Prices come from the shared plan definition (premium-config.js) — the
    // static markup carries the same values as a first render, and this
    // re-renders them from the definition on every open so the two cannot drift.
    if (!Array.isArray(window.PREMIUM_PLANS)) return;
    window.PREMIUM_PLANS.forEach((plan) => {
        const priceEl = document.getElementById('premiumPlanPrice-' + plan.key);
        if (priceEl) priceEl.textContent = '₹' + plan.price;
        const strikeEl = document.getElementById('premiumPlanStrike-' + plan.key);
        if (strikeEl) strikeEl.textContent = plan.strike == null ? '' : '₹' + plan.strike;
        const saveEl = document.getElementById('premiumPlanSave-' + plan.key);
        if (saveEl) {
            saveEl.textContent = plan.save == null ? ''
                : (plan.save > 0 ? 'Save ₹' + plan.save : 'No discount');
        }
        const perMonthEl = document.getElementById('premiumPlanPerMonth-' + plan.key);
        if (perMonthEl) perMonthEl.textContent = '₹' + plan.perMonth + '/mo';
    });
    // Keep the subscribe button in sync with the current selection.
    const selected = document.querySelector('.premium-plan-option.selected');
    if (selected) setModalSelectedPlan(selected.getAttribute('data-plan'));
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
