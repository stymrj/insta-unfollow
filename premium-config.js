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
// PREMIUM_BY_DEFAULT: everyone is premium until you deploy the payment worker.
// Flip this to false once PAYMENT_API_URL points at a live worker and you start selling.
window.PREMIUM_BY_DEFAULT = true;

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
      return { turu: 'premium', expiry: null };
    }
    try {
      const data = await chrome.storage.local.get(['membership', 'user_info']);
      const stored = data.membership || {};
      const userInfo = data.user_info;

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
            await chrome.storage.local.set({
              membership: {
                uye_id: userInfo.id,
                turu: 'premium',
                token: status.token,
                kayit_tarihi: new Date().toISOString()
              }
            });
            return { turu: 'premium', expiry: parsed ? new Date(parsed.payload.exp).toISOString() : null };
          }
          if (status.premium === false) {
            // The worker's answer wins: an admin revoke overrides any locally stored token.
            return { turu: 'free' };
          }
        } catch (error) {
          console.warn('Worker membership check failed, using local token:', error);
        }
      }

      if (stored.turu === 'premium' && stored.token && await verifyPremiumToken(stored.token)) {
        return { turu: 'premium', expiry: stored.expiry || null };
      }

      const email = userInfo && userInfo.email;
      if (email && window.PREMIUM_ADMIN_EMAIL && email.toLowerCase() === window.PREMIUM_ADMIN_EMAIL.toLowerCase()) {
        return { turu: 'premium', expiry: null };
      }

      return { turu: 'free' };
    } catch (error) {
      console.error('getPremiumMembership failed:', error);
      return { turu: 'free' };
    }
  }

  window.verifyPremiumToken = verifyPremiumToken;
  window.getPremiumMembership = getPremiumMembership;
})();