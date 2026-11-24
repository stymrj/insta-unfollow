/**
 * review-prompt.js
 * 
 * Manages the smart review & rating prompt for Insta Unfollow.
 * 
 * Growth Mechanism:
 * - Users who rate 5 stars on the Chrome Web Store receive +100 FREE bonus unfollows!
 * 
 * Anti-Annoyance Rules:
 * - Only triggered after value moments (e.g. 1st completed scan or 5+ successful unfollows).
 * - "Rate" -> opens Web Store review URL, awards +100 bonus unfollows, NEVER prompts again.
 * - "Don't ask again" -> permanently dismissed, NEVER prompts again.
 * - "Maybe later" -> snoozes prompt for at least 7 days (maximum 2 lifetime prompts).
 */
(function (root) {
  'use strict';

  var BONUS_AMOUNT = 100;
  var COOLDOWN_DAYS = 7;
  var MAX_PROMPTS = 2;
  var MIN_UNFOLLOWS_TRIGGER = 5;

  var ReviewPrompt = {
    BONUS_AMOUNT: BONUS_AMOUNT,
    STORE_REVIEW_URL: 'https://chromewebstore.google.com/detail/insta-unfollow-followers/kdlobnohhjkneflmopckfidfekdkokcd/reviews',

    getReviewUrl: function () {
      return this.STORE_REVIEW_URL;
    },

    /**
     * Checks if the user is eligible to see the review banner.
     */
    shouldShowPrompt: async function () {
      try {
        var data = await chrome.storage.local.get(['review_status']);
        var status = data.review_status || { state: 'pending', prompt_count: 0, last_prompted: 0 };

        // Never show if already rated or permanently declined
        if (status.state === 'rated' || status.state === 'declined') {
          return false;
        }

        // Never exceed max lifetime impressions
        if ((status.prompt_count || 0) >= MAX_PROMPTS) {
          return false;
        }

        // Respect 7-day snooze cooldown
        if (status.last_prompted > 0) {
          var daysSince = (Date.now() - status.last_prompted) / (1000 * 60 * 60 * 24);
          if (daysSince < COOLDOWN_DAYS) {
            return false;
          }
        }

        return true;
      } catch (e) {
        return false;
      }
    },

    /**
     * Check if user has already claimed the rating bonus.
     */
    isBonusClaimed: async function () {
      try {
        var data = await chrome.storage.local.get(['review_status']);
        return data.review_status && data.review_status.state === 'rated';
      } catch (e) {
        return false;
      }
    },

    /**
     * Get remaining review bonus unfollows.
     */
    getBonusAllowance: async function () {
      try {
        var data = await chrome.storage.local.get(['review_bonus_unfollows']);
        return Number(data.review_bonus_unfollows) || 0;
      } catch (e) {
        return 0;
      }
    },

    /**
     * Grant the +100 bonus unfollows and mark as rated.
     */
    claimBonus: async function () {
      try {
        var data = await chrome.storage.local.get(['review_status', 'review_bonus_unfollows']);
        var status = data.review_status || {};
        status.state = 'rated';
        status.rated_at = Date.now();

        await chrome.storage.local.set({
          review_status: status,
          review_bonus_unfollows: BONUS_AMOUNT
        });

        // Open Web Store review page
        if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) {
          chrome.tabs.create({ url: this.getReviewUrl() });
        } else {
          window.open(this.getReviewUrl(), '_blank', 'noopener');
        }

        return true;
      } catch (e) {
        console.error('Failed to claim review bonus:', e);
        return false;
      }
    },

    /**
     * Records a dismiss or snooze action.
     */
    recordAction: async function (action) {
      try {
        var data = await chrome.storage.local.get(['review_status']);
        var status = data.review_status || { state: 'pending', prompt_count: 0 };

        if (action === 'declined') {
          status.state = 'declined';
        } else if (action === 'remind_later') {
          status.state = 'remind_later';
          status.last_prompted = Date.now();
          status.prompt_count = (status.prompt_count || 0) + 1;
        }

        await chrome.storage.local.set({ review_status: status });
      } catch (e) {}
    },

    /**
     * Track a successful unfollow. Once threshold is met, check if prompt should show.
     */
    trackSuccessfulUnfollow: async function () {
      try {
        var data = await chrome.storage.local.get(['review_status']);
        var status = data.review_status || { state: 'pending', prompt_count: 0, successful_unfollows: 0 };
        status.successful_unfollows = (status.successful_unfollows || 0) + 1;
        await chrome.storage.local.set({ review_status: status });

        if (status.successful_unfollows >= MIN_UNFOLLOWS_TRIGGER) {
          if (await this.shouldShowPrompt()) {
            this.renderBanner();
          }
        }
      } catch (e) {}
    },

    /**
     * Render the floating review banner.
     */
    renderBanner: function () {
      if (document.getElementById('reviewFloatingBanner')) return;

      var self = this;
      var banner = document.createElement('div');
      banner.id = 'reviewFloatingBanner';
      banner.className = 'review-floating-banner';

      banner.innerHTML = [
        '<div class="review-banner-header">',
        '  <div class="review-banner-badge">🎁 SPECIAL GIFT</div>',
        '  <button type="button" class="review-banner-close" id="reviewBannerClose" aria-label="Close">&times;</button>',
        '</div>',
        '<div class="review-banner-body">',
        '  <div class="review-banner-stars">⭐⭐⭐⭐⭐</div>',
        '  <h4 class="review-banner-title">Get +100 Free Bonus Unfollows!</h4>',
        '  <p class="review-banner-text">',
        '    Enjoying Insta Unfollow? Leave a quick 5-star review on the Chrome Web Store and instantly unlock <strong>+100 bonus unfollows</strong> for free!',
        '  </p>',
        '</div>',
        '<div class="review-banner-actions">',
        '  <button type="button" id="reviewClaimBtn" class="review-btn-claim">',
        '    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">',
        '      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>',
        '    </svg>',
        '    <span>Rate 5 Stars & Claim +100</span>',
        '  </button>',
        '  <div class="review-banner-subactions">',
        '    <button type="button" id="reviewLaterBtn" class="review-btn-link">Maybe later</button>',
        '    <span class="review-sep">•</span>',
        '    <button type="button" id="reviewNeverBtn" class="review-btn-link">Don\'t ask again</button>',
        '  </div>',
        '</div>'
      ].join('');

      document.body.appendChild(banner);

      // Claim button
      var claimBtn = document.getElementById('reviewClaimBtn');
      if (claimBtn) {
        claimBtn.addEventListener('click', async function () {
          claimBtn.disabled = true;
          claimBtn.innerHTML = '<span>Opening Store...</span>';
          await self.claimBonus();
          banner.remove();

          if (typeof window.showToast === 'function') {
            window.showToast('🎉 +100 Bonus Unfollows added to your account! Thank you for your support!', 'success');
          }
          if (typeof window.updateDailyAllowanceUI === 'function') {
            window.updateDailyAllowanceUI();
          }
        });
      }

      // Close (X) / Later button
      var closeBtn = document.getElementById('reviewBannerClose');
      if (closeBtn) {
        closeBtn.addEventListener('click', function () {
          self.recordAction('remind_later');
          banner.remove();
        });
      }

      var laterBtn = document.getElementById('reviewLaterBtn');
      if (laterBtn) {
        laterBtn.addEventListener('click', function () {
          self.recordAction('remind_later');
          banner.remove();
        });
      }

      // Never ask again
      var neverBtn = document.getElementById('reviewNeverBtn');
      if (neverBtn) {
        neverBtn.addEventListener('click', function () {
          self.recordAction('declined');
          banner.remove();
        });
      }
    }
  };

  root.ReviewPrompt = ReviewPrompt;
})(typeof window !== 'undefined' ? window : this);
