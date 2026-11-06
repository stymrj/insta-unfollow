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
    
    if (oldPriceEl) oldPriceEl.textContent = '$25';
    if (newPriceEl) newPriceEl.textContent = '$6.99';
    
    const discountText = document.getElementById('premiumDiscountText');
    if (discountText) {
        discountText.textContent = '72% OFF';
    }
    
    const yearlyOldPriceEl = document.getElementById('premiumYearlyOldPrice');
    const yearlyNewPriceEl = document.getElementById('premiumYearlyNewPrice');
    
    if (yearlyOldPriceEl) yearlyOldPriceEl.textContent = '$129.99';
    if (yearlyNewPriceEl) yearlyNewPriceEl.textContent = '$74.99';
    
    const yearlyDiscountText = document.getElementById('premiumYearlyDiscountText');
    if (yearlyDiscountText) {
        yearlyDiscountText.textContent = '42% OFF';
    }
    
    const savingsEl = document.getElementById('premiumYearlySavings');
    if (savingsEl) {
        savingsEl.textContent = 'Save $8.89/year';
    }
}

function updatePremiumModalContent() {
    // Modal content is now handled by individual card buttons
    // No need for separate subscribe section
}

  const t = (key) => (typeof getMessage === 'function' ? getMessage(key) : '') || '';

  function handlePremiumSubscribe(planType = 'monthly') {
  (async () => {
    try {
      const already = await getPremiumMembership();
      if (already.turu === 'premium') {
        closePremiumModal();
        return;
      }

      const button = document.querySelector(`.premium-card-subscribe-button[data-plan="${planType}"]`);
      const originalText = button ? button.textContent : '';
      if (button) button.textContent = t('premiumOpeningPayment') || 'Opening payment…';

      const data = await chrome.storage.local.get(['user_info']);
      const userId = (data.user_info && data.user_info.id) || '';

      const response = await fetch(window.PAYMENT_API_URL + '/create-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: planType, userId })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.short_url) {
        throw new Error(payload.error || ('payment link failed: ' + response.status));
      }

      window.open(payload.short_url, '_blank');

      // A fixed Paytm link cannot be polled for its order status, so tell the user what to
      // expect: premium activates once the admin confirms the payment from the console.
      // The poll below still runs — it picks up the moment that confirmation lands.
      if (payload.paytm) {
        if (button) button.textContent = t('premiumPaytmNote') || 'Complete payment in the opened tab — premium activates once confirmed';
      }

      // Wait for the payment to land; Razorpay settles within seconds of success, an admin
      // grant from the console lands within minutes of a Paytm payment.
      const poll = async (attemptsLeft) => {
        if (attemptsLeft <= 0) {
          if (button) button.textContent = originalText;
          return;
        }
        try {
          const email = (data.user_info && data.user_info.email) || '';
          const statusResponse = await fetch(
            window.PAYMENT_API_URL + '/status?u=' + encodeURIComponent(userId) +
            '&email=' + encodeURIComponent(email)
          );
          const status = await statusResponse.json();
          if (status.premium && status.token) {
            await chrome.storage.local.set({
              membership: {
                uye_id: userId,
                turu: 'premium',
                token: status.token,
                kayit_tarihi: new Date().toISOString()
              }
            });
            if (button) button.textContent = '✓ ' + (t('premiumActive') || 'Premium active!');
            setTimeout(() => {
              closePremiumModal();
              location.reload();
            }, 900);
            return;
          }
        } catch (error) {
          console.error('Payment status check failed:', error);
        }
        setTimeout(() => poll(attemptsLeft - 1), 4000);
      };
      poll(75); // ~5 minutes of checking
    } catch (error) {
      console.error('handlePremiumSubscribe failed:', error);
      const button = document.querySelector('.premium-card-subscribe-button');
      if (button) button.textContent = t('premiumPaymentError') || 'Payment failed — try again';
      setTimeout(() => {
        if (button) button.textContent = t('premiumRetry') || 'Try again';
      }, 2500);
    }
  })();
}
