/**
 * Interactive post-install onboarding controller for welcome.html.
 * Detects live Google sign-in + Instagram browser session status and launches Analyzer / Bot Scan.
 */
(function () {
  'use strict';

  const state = {
    pinned: false,
    googleLoggedIn: false,
    googleUser: null,
    membership: null,
    igConnected: false,
    igSession: null
  };

  const $ = (id) => document.getElementById(id);

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  function updateReadinessSummary() {
    const completed =
      (state.pinned ? 1 : 0) +
      (state.googleLoggedIn ? 1 : 0) +
      (state.igConnected ? 1 : 0);

    const fill = $('readinessFill');
    const prog = $('readinessProgress');
    const frac = $('readinessFraction');
    const label = $('readinessLabel');

    if (fill) fill.style.width = `${Math.round((completed / 3) * 100)}%`;
    if (prog) prog.setAttribute('aria-valuenow', String(completed));
    if (frac) frac.textContent = `${completed} / 3 Ready`;

    if (label) {
      if (state.googleLoggedIn && state.igConnected) {
        label.textContent = '🎉 All set! Click Launch Non-Follower Analyzer below to start scanning.';
      } else if (!state.googleLoggedIn && !state.igConnected) {
        label.textContent = 'Sign in with Google & log into Instagram.com to unlock scanning.';
      } else if (!state.googleLoggedIn) {
        label.textContent = 'Almost ready — complete Step 2 (Sign in with Google).';
      } else {
        label.textContent = 'Almost ready — log into instagram.com in this browser (Step 3).';
      }
    }
  }

  function renderPinState() {
    const card = $('stepCardPin');
    const badge = $('stepPinBadge');
    const btn = $('markPinnedBtn');
    const text = $('markPinnedText');
    const callout = $('pinCallout');

    if (state.pinned) {
      card?.classList.add('is-complete');
      if (badge) { badge.className = 'status-pill ready'; badge.textContent = '✓ Pinned'; }
      if (btn) btn.className = 'step-btn done';
      if (text) text.textContent = 'Pinned to Toolbar ✓';
      callout?.classList.add('hidden');
    } else {
      card?.classList.remove('is-complete');
      if (badge) { badge.className = 'status-pill pending'; badge.textContent = 'Recommended'; }
      if (btn) btn.className = 'step-btn outline';
      if (text) text.textContent = "I've Pinned It ✓";
    }
    updateReadinessSummary();
  }

  function renderGoogleState() {
    const card = $('stepCardGoogle');
    const badge = $('stepGoogleBadge');
    const box = $('googleAccountBox');
    const btn = $('welcomeGoogleBtn');
    const btnText = $('welcomeGoogleBtnText');

    if (state.googleLoggedIn && state.googleUser) {
      card?.classList.add('is-complete');
      const isPrem = state.membership?.turu === 'premium' || state.membership?.turu === 'Premium';
      if (badge) { badge.className = 'status-pill ready'; badge.textContent = '✓ Connected'; }
      if (box) {
        const pic = state.googleUser.picture || 'img/48.png';
        const name = state.googleUser.name || state.googleUser.email || 'Google Account';
        box.innerHTML = `
          <div class="account-connected">
            <img src="${escapeHtml(pic)}" alt="" class="account-avatar" referrerpolicy="no-referrer">
            <div class="account-meta">
              <span class="account-name">${escapeHtml(name)}</span>
              <span class="account-sub">${isPrem ? '★ Premium Plan Active' : '✓ Free Plan Ready'}</span>
            </div>
          </div>`;
        const img = box.querySelector('img');
        if (img) img.addEventListener('error', () => { img.src = 'img/48.png'; }, { once: true });
      }
      if (btn) { btn.className = 'step-btn done'; btn.disabled = true; }
      if (btnText) btnText.textContent = 'Signed In with Google ✓';
    } else {
      card?.classList.remove('is-complete');
      if (badge) { badge.className = 'status-pill warn'; badge.textContent = 'Sign-In Needed'; }
      if (box) {
        box.innerHTML = `
          <div class="account-placeholder">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            <span>Click below to sign in with Google</span>
          </div>`;
      }
      if (btn) { btn.className = 'step-btn google'; btn.disabled = false; }
      if (btnText) btnText.textContent = 'Continue with Google';
    }
    updateReadinessSummary();
  }

  function renderIgState(checking = false) {
    const card = $('stepCardIg');
    const badge = $('stepIgBadge');
    const box = $('igAccountBox');
    const openBtn = $('openIgBtn');

    if (checking) {
      if (badge) { badge.className = 'status-pill pending'; badge.textContent = 'Checking…'; }
      return;
    }

    if (state.igConnected && state.igSession) {
      card?.classList.add('is-complete');
      if (badge) { badge.className = 'status-pill ready'; badge.textContent = '✓ Session Active'; }
      const handle = '@' + (state.igSession.username || 'instagram');
      const counts = (typeof state.igSession.followerCount === 'number' && typeof state.igSession.followingCount === 'number')
        ? `${state.igSession.followerCount.toLocaleString()} followers · ${state.igSession.followingCount.toLocaleString()} following`
        : 'Active Instagram session detected';
      if (box) {
        box.innerHTML = `
          <div class="account-connected">
            <img src="img/48.png" alt="" class="account-avatar" id="welcomeIgAvatar">
            <div class="account-meta">
              <span class="account-name">${escapeHtml(handle)}</span>
              <span class="account-sub">✓ ${escapeHtml(counts)}</span>
            </div>
          </div>`;
        if (state.igSession.profilePicUrl) {
          fetch(state.igSession.profilePicUrl, { credentials: 'omit', mode: 'cors' })
            .then((r) => r.ok ? r.blob() : null)
            .then((b) => {
              const avatarEl = $('welcomeIgAvatar');
              if (b && b.type.startsWith('image/') && avatarEl) {
                avatarEl.src = URL.createObjectURL(b);
              }
            })
            .catch(() => {});
        }
      }
      if (openBtn) {
        openBtn.className = 'step-btn done';
        openBtn.innerHTML = '<span>Instagram Connected ✓</span>';
      }
    } else {
      card?.classList.remove('is-complete');
      if (badge) { badge.className = 'status-pill warn'; badge.textContent = 'Login Needed'; }
      if (box) {
        box.innerHTML = `
          <div class="account-placeholder">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>
            <span>Log into instagram.com in this browser</span>
          </div>`;
      }
      if (openBtn) {
        openBtn.className = 'step-btn indigo';
        openBtn.innerHTML = '<span>Open Instagram.com ↗</span>';
      }
    }
    updateReadinessSummary();
  }

  async function checkGoogleLogin() {
    try {
      const resp = await chrome.runtime.sendMessage({ action: 'checkLoginStatus' });
      if (resp && resp.success && resp.data && resp.data.isLoggedIn) {
        state.googleLoggedIn = true;
        state.googleUser = resp.data.userInfo;
        state.membership = resp.data.membership;
      } else {
        state.googleLoggedIn = false;
        state.googleUser = null;
      }
    } catch {
      state.googleLoggedIn = false;
    }
    renderGoogleState();
  }

  async function checkInstagramSession(force = false) {
    renderIgState(true);
    try {
      if (window.IgSession && typeof window.IgSession.fetchSession === 'function') {
        const session = await window.IgSession.fetchSession(force);
        if (session && session.status === 'ok' && session.id) {
          state.igConnected = true;
          state.igSession = session;
          renderIgState(false);
          return;
        }
      }
    } catch {}
    state.igConnected = false;
    state.igSession = null;
    renderIgState(false);
  }

  async function handleGoogleSignIn() {
    const btn = $('welcomeGoogleBtn');
    const btnText = $('welcomeGoogleBtnText');
    const feedback = $('heroActionFeedback');
    if (btn) btn.disabled = true;
    if (btnText) btnText.textContent = 'Signing in…';
    if (feedback) feedback.textContent = '';

    try {
      const resp = await chrome.runtime.sendMessage({ action: 'googleLogin' });
      if (resp && resp.success && resp.data) {
        state.googleLoggedIn = true;
        state.googleUser = resp.data.userInfo;
        state.membership = resp.data.membership;
        renderGoogleState();
        return true;
      } else {
        if (feedback) feedback.textContent = (resp && resp.error) || 'Google sign-in was cancelled.';
      }
    } catch (err) {
      if (feedback) feedback.textContent = err.message || 'Sign-in failed. Please try again.';
    }
    renderGoogleState();
    return false;
  }

  async function openTargetPage(pageFile) {
    const feedback = $('heroActionFeedback');
    if (feedback) feedback.textContent = '';

    if (!state.googleLoggedIn) {
      if (feedback) feedback.textContent = 'Connecting your Google account first…';
      const signedIn = await handleGoogleSignIn();
      if (!signedIn) return;
    }

    if (!state.igConnected) {
      await checkInstagramSession(true);
      if (!state.igConnected) {
        if (feedback) {
          feedback.textContent = 'Please log into instagram.com first (Step 3 below), then click Launch again!';
        }
        $('stepCardIg')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
    }

    window.location.href = chrome.runtime.getURL(pageFile);
  }

  document.addEventListener('DOMContentLoaded', async () => {
    const verBadge = $('welcomeVersionBadge');
    if (verBadge && chrome.runtime && chrome.runtime.getManifest) {
      verBadge.textContent = 'v' + chrome.runtime.getManifest().version;
    }

    try {
      const stored = await chrome.storage.local.get(['welcomePinnedDone']);
      state.pinned = !!stored.welcomePinnedDone;
    } catch {}
    renderPinState();

    $('dismissPinCallout')?.addEventListener('click', () => {
      $('pinCallout')?.classList.add('hidden');
    });

    $('markPinnedBtn')?.addEventListener('click', async () => {
      state.pinned = !state.pinned;
      try { await chrome.storage.local.set({ welcomePinnedDone: state.pinned }); } catch {}
      renderPinState();
    });

    $('welcomeGoogleBtn')?.addEventListener('click', handleGoogleSignIn);
    $('recheckIgBtn')?.addEventListener('click', () => checkInstagramSession(true));
    $('heroLaunchAnalyzerBtn')?.addEventListener('click', () => openTargetPage('analyzer.html'));
    $('heroBotScanBtn')?.addEventListener('click', () => openTargetPage('bot-scan.html'));

    // Auto re-check Instagram & Google status whenever the user returns to this tab!
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        if (!state.googleLoggedIn) checkGoogleLogin();
        if (!state.igConnected) checkInstagramSession(true);
      }
    });

    await Promise.all([
      checkGoogleLogin(),
      checkInstagramSession(false)
    ]);
  });
})();
