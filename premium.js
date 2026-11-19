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
        
        // Update pricing and subscription button visibility
        updatePremiumModalContent();
    }
}

function closePremiumModal() {
    const premiumModal = document.getElementById('premiumModal');
    if (premiumModal) {
        premiumModal.classList.remove('active');
        document.body.style.overflow = '';
    }
}

function initializePremiumModal() {
    // Fetch prices from API
    fetchPremiumPrices();
}

async function fetchPremiumPrices() {
    // Static pricing — no external server
    const oldPriceEl = document.getElementById('premiumOldPrice');
    const newPriceEl = document.getElementById('premiumNewPrice');
    
    if (oldPriceEl) oldPriceEl.textContent = '₹699';
    if (newPriceEl) newPriceEl.textContent = '₹199';
    
    const discountText = document.getElementById('premiumDiscountText');
    if (discountText) {
        discountText.textContent = '72% OFF';
    }
    
    const yearlyOldPriceEl = document.getElementById('premiumYearlyOldPrice');
    const yearlyNewPriceEl = document.getElementById('premiumYearlyNewPrice');
    
    if (yearlyOldPriceEl) yearlyOldPriceEl.textContent = '₹2,388';
    if (yearlyNewPriceEl) yearlyNewPriceEl.textContent = '₹1,499';
    
    const yearlyDiscountText = document.getElementById('premiumYearlyDiscountText');
    if (yearlyDiscountText) {
        yearlyDiscountText.textContent = '37% OFF';
    }
    
    const savingsEl = document.getElementById('premiumYearlySavings');
    if (savingsEl) {
        savingsEl.textContent = 'Save ₹889/year vs monthly';
    }
}

function updatePremiumModalContent() {
    // Modal content is now handled by individual card buttons
    // No need for separate subscribe section
}

  const t = (key) => (typeof getMessage === 'function' ? getMessage(key) : '') || '';

  function handlePremiumSubscribe(planType = 'monthly') {
  (async () => {
    const button = document.querySelector(`.premium-card-subscribe-button[data-plan="${planType}"]`);
    const originalText = button ? button.textContent : '';
    // Show a failure on the button itself, then offer a retry. The message names the
    // real problem: never "not configured" when the worker URL is already set.
    const fail = (message) => {
      if (button) {
        button.textContent = message;
        setTimeout(() => {
          if (button) button.textContent = t('premiumRetry') || 'Try again';
        }, 4000);
      }
    };
    try {
      const already = await getPremiumMembership();
      if (already.turu === 'premium') {
        closePremiumModal();
        return;
      }

      if (button) button.textContent = t('premiumOpeningPayment') || 'Opening payment…';

      const data = await chrome.storage.local.get(['user_info']);
      const userId = (data.user_info && data.user_info.id) || '';
      const email = (data.user_info && data.user_info.email) || '';

      const apiUrl = window.PAYMENT_API_URL;
      if (!apiUrl || typeof apiUrl !== 'string' || apiUrl.includes('PASTE-YOUR-WORKER')) {
        fail('Payment is not configured yet.');
        return;
      }

      let response;
      try {
        response = await fetch(apiUrl + '/create-link', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan: planType, userId })
        });
      } catch (error) {
        console.error('Payment link failed:', error);
        fail('Could not reach the payment server — check your connection and try again.');
        return;
      }
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.short_url) {
        fail(payload.error || 'Could not reach the payment server — check your connection and try again.');
        return;
      }

      window.open(payload.short_url, '_blank');

      // A fixed Paytm link cannot be polled for its order status, so tell the user what to
      // expect: premium activates once the admin confirms the payment from the console.
      // The poll below still runs — it picks up the moment that confirmation lands.
      if (payload.paytm) {
        if (button) button.textContent = t('premiumPaytmNote') || 'Complete payment in the opened tab — premium activates once confirmed';
      }

      // Wait for the payment to land; Razorpay settles within seconds of success, an admin
      // grant from the console lands within minutes of a Paytm payment. Shared with the
      // popup subscribe button (see pollPremiumActivation in premium-config.js).
      window.pollPremiumActivation({
        userId,
        email,
        onActive: () => {
          if (button) button.textContent = '✓ ' + (t('premiumActive') || 'Premium active!');
          setTimeout(() => {
            closePremiumModal();
            location.reload();
          }, 900);
        },
        onTimeout: () => {
          if (button) button.textContent = originalText;
        }
      });
    } catch (error) {
      console.error('handlePremiumSubscribe failed:', error);
      fail(t('premiumPaymentError') || 'Payment failed — try again');
    }
  })();
}
