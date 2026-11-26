// Background Service Worker - Login with new tab method
// This method completely solves the popup closing issue and works on all platforms

// Configure declarativeNetRequest rules so extension-initiated Instagram requests match real
// browser header shapes:
//   - GET/HEAD requests: Referer set to instagram.com, Origin REMOVED (browsers never send Origin on same-origin GETs!)
//   - POST requests: both Origin and Referer set to instagram.com
const IG_DNR_RULE_IDS = [1, 2, 3, 4, 5, 6];
async function installInstagramHeaderRules() {
  try {
    if (typeof chrome === 'undefined' || !chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateDynamicRules) {
      return;
    }
    const getHeaders = [
      { header: 'origin', operation: chrome.declarativeNetRequest.HeaderOperation.REMOVE },
      { header: 'referer', operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: 'https://www.instagram.com/' }
    ];
    const postHeaders = [
      { header: 'origin', operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: 'https://www.instagram.com' },
      { header: 'referer', operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: 'https://www.instagram.com/' }
    ];
    const urlFilters = ['||instagram.com/api/', '||instagram.com/graphql/', '||instagram.com/web/'];
    const rules = [];
    urlFilters.forEach((urlFilter, idx) => {
      rules.push({
        id: idx + 1,
        priority: 1,
        action: {
          type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
          requestHeaders: getHeaders
        },
        condition: {
          urlFilter,
          excludedRequestMethods: ['post'],
          resourceTypes: [chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST]
        }
      });
      rules.push({
        id: idx + 4,
        priority: 2,
        action: {
          type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
          requestHeaders: postHeaders
        },
        condition: {
          urlFilter,
          requestMethods: ['post'],
          resourceTypes: [chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST]
        }
      });
    });

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: IG_DNR_RULE_IDS,
      addRules: rules
    });
    console.log('[background] Instagram declarativeNetRequest GET/POST header rules installed');
  } catch (err) {
    console.error('[background] Failed to install Instagram header rules:', err);
  }
}
installInstagramHeaderRules();
chrome.runtime.onInstalled.addListener((details) => {
  installInstagramHeaderRules();
  ensureInstagramPagePort({ openIfMissing: false }).catch(() => {});
  if (details && details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
  }
});

// Owner bypass: this Google account is always premium, no payment needed.
const PREMIUM_ADMIN_EMAIL = 'sstymrj@gmail.com';
// Everyone premium until the payment worker is deployed and selling starts.
const PREMIUM_BY_DEFAULT = false;
// Public key that verifies premium tokens signed by the payment worker
// (see premium-config.js in the extension pages for the same value).
const PREMIUM_PUBLIC_KEY = '1ad6e3be3cdfab04e5078b78ab5da26adb2ba93d0b8ec2d0fe23f66f073671ad';

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

function base64urlDecode(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** v1.<payload-b64url>.<signature-b64url> — payload is JSON {sub, plan, exp}, or null. */
function parsePremiumToken(token) {
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

/** v1.<payload-b64url>.<signature-b64url> — returns true only for a valid, unexpired token. */
async function verifyPremiumToken(token) {
  const parsed = parsePremiumToken(token);
  if (!parsed) return false;
  if (Date.now() > parsed.payload.exp) return false;
  try {
    const key = await crypto.subtle.importKey('raw', hexToBytes(PREMIUM_PUBLIC_KEY), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, parsed.signature, parsed.message);
  } catch (error) {
    console.error('Premium token verification failed:', error);
    return false;
  }
}

/**
 * The membership a login/status check should report. The payment worker is the
 * authority when its URL is configured (same storage key premium-config.js writes
 * on every extension page load): a worker answer wins over any locally stored
 * token, and only a failed fetch or an unusable worker response falls back to
 * the local token. A token only counts when its signature verifies AND its sub
 * matches the signed-in user — a token for another user is rejected everywhere.
 * Hand-edited storage no longer counts as premium.
 */
async function resolveMembership(userInfo) {
    if (PREMIUM_BY_DEFAULT) {
      return { uye_id: userInfo && userInfo.id, turu: 'premium' };
    }
    const userId = userInfo && userInfo.id;
    const stored = await chrome.storage.local.get('membership');
    const m = stored.membership || {};

    // Preserve active promotional redeem code grants so checkLoginStatus / re-login never wipes them out.
    if (m.turu === 'premium' && m.grantExpiresAt && Date.now() < m.grantExpiresAt) {
      return {
        ...m,
        uye_id: userId || m.uye_id,
        turu: 'premium',
        expiry: new Date(m.grantExpiresAt).toISOString()
      };
    }

    if (userId) {
      try {
        const { paymentApiUrl } = await chrome.storage.local.get('paymentApiUrl');
        if (paymentApiUrl && !paymentApiUrl.includes('PASTE-YOUR-WORKER')) {
          const statusResponse = await fetch(
            paymentApiUrl + '/status?u=' + encodeURIComponent(userId) +
            '&email=' + encodeURIComponent((userInfo && userInfo.email) || '')
          );
          const status = await statusResponse.json();
          if (status.banned) {
            return { uye_id: userId, turu: 'free', banned: true, kayit_tarihi: new Date().toISOString() };
          }
          if (status.premium && status.token && await verifyPremiumToken(status.token)) {
            const parsed = parsePremiumToken(status.token);
            if (parsed && parsed.payload.sub === userId) {
              return {
                uye_id: userId,
                turu: 'premium',
                token: status.token,
                kayit_tarihi: new Date().toISOString(),
                expiry: new Date(parsed.payload.exp).toISOString()
              };
            }
            // Verified token for another user: do not trust it; fall through
            // to the local-token fallback below.
          }
          if (status.premium === false) {
            // The worker's answer wins: an admin revoke overrides any locally stored token.
            return { uye_id: userId, turu: 'free', kayit_tarihi: new Date().toISOString() };
          }
        }
      } catch (error) {
        console.warn('Worker membership check failed, using local token:', error);
      }
    }

  if (m.turu === 'premium' && m.token && await verifyPremiumToken(m.token)) {
    const parsed = parsePremiumToken(m.token);
    if (parsed && userId && parsed.payload.sub === userId) {
      return { ...m, uye_id: userId, expiry: new Date(parsed.payload.exp).toISOString() };
    }
    // Verified token for another user (or no signed-in user to match against): not premium.
  }
  if (userInfo && userInfo.email && userInfo.email.toLowerCase() === PREMIUM_ADMIN_EMAIL.toLowerCase()) {
    return { ...m, uye_id: userInfo.id, turu: 'premium' };
  }
  return { uye_id: userId, turu: 'free', kayit_tarihi: new Date().toISOString() };
}

// Perform login in background - New tab method
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'googleLogin') {
    handleGoogleLoginWithNewTab()
      .then(result => {
        sendResponse({ success: true, data: result });
      })
      .catch(error => {
        console.error('Background login error:', error);
        sendResponse({ success: false, error: error.message || 'Login failed' });
      });
    return true; // Async response için gerekli
  }
  
  if (request.action === 'checkLoginStatus') {
    checkLoginStatus()
      .then(result => {
        sendResponse({ success: true, data: result });
      })
      .catch(error => {
        console.error('Check login status error:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }
  
  if (request.action === 'logout') {
    handleLogout()
      .then(() => {
        sendResponse({ success: true });
      })
      .catch(error => {
        console.error('Logout error:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }
});

/**
 * Tell the payment worker about this user so the admin console can list them.
 *
 * The worker URL is set in premium-config.js, which pages copy into storage on load
 * (the service worker cannot load that file). A placeholder URL means the worker is
 * not deployed yet, and registration is skipped. Failures are swallowed on purpose:
 * reporting a user must never break login.
 */
async function notifyWorkerAboutUser(userInfo) {
  if (!userInfo || !userInfo.id) return;
  try {
    const { paymentApiUrl } = await chrome.storage.local.get('paymentApiUrl');
    if (!paymentApiUrl || paymentApiUrl.includes('PASTE-YOUR-WORKER')) return;
    await fetch(paymentApiUrl + '/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        googleId: String(userInfo.id),
        email: userInfo.email || '',
        name: userInfo.name || userInfo.given_name || '',
        picture: userInfo.picture || ''
      })
    });
  } catch (error) {
    console.warn('User registration with worker skipped:', error);
  }
}

// launchWebAuthFlow ile Google OAuth2 token al
// Tüm Chromium tabanlı tarayıcılarda çalışır (Chrome, Brave, Edge, Opera, Vivaldi)
async function getTokenViaWebAuthFlow() {
  const redirectURL = chrome.identity.getRedirectURL();
  const clientId = '483666926131-ho9r406mnt14ssnlv25nv108fbpmj5s0.apps.googleusercontent.com';
  const scopes = encodeURIComponent('https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email');

  // For debugging redirect_uri_mismatch: this exact URL must be listed under
  // Authorized redirect URIs in your Google Cloud OAuth client.
  console.log('OAuth redirect URI:', redirectURL);

  const authURL = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&response_type=token&redirect_uri=${encodeURIComponent(redirectURL)}&scope=${scopes}`;

  const responseUrl = await chrome.identity.launchWebAuthFlow({
    url: authURL,
    interactive: true
  });

  // URL'den access_token'ı parse et
  const url = new URL(responseUrl);
  const params = new URLSearchParams(url.hash.substring(1));
  const token = params.get('access_token');

  if (!token) {
    throw new Error('No access token in response');
  }

  return token;
}

// Background service worker'da Google login işlemi
async function handleGoogleLoginWithNewTab() {
  try {
    // launchWebAuthFlow ile token al - tüm tarayıcılarda çalışır
    const accessToken = await getTokenViaWebAuthFlow();

    if (!accessToken) {
      throw new Error('No access token received from Google');
    }
    
    // Make sure token is a string
    const tokenString = typeof accessToken === 'string' ? accessToken : (accessToken.token || accessToken);
    
    if (!tokenString || typeof tokenString !== 'string') {
      throw new Error('Invalid token format received');
    }
    
    // Kısa bir bekleme - Token'ın aktif olması için
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Get user info and send to API
    const result = await processLoginWithToken(tokenString);
    return result;
    
  } catch (error) {
    console.error('Background login error:', error);
    
    // Make error messages user-friendly
    let errorMessage = error.message || 'Unknown error';
    
    if (errorMessage.includes('redirect_uri') || errorMessage.includes('OAuth2')
        || errorMessage.toLowerCase().includes('could not be loaded')) {
      const redirectURL = chrome.identity.getRedirectURL();
      errorMessage = `Redirect URI mismatch. Add "${redirectURL}" to Authorized redirect URIs in your Google Cloud OAuth client, then try again.`;
    } else if (errorMessage.includes('user_cancelled') || errorMessage.includes('canceled')) {
      errorMessage = 'Login cancelled.';
    } else if (errorMessage.includes('network') || errorMessage.includes('fetch')) {
      errorMessage = 'Network error. Please check your internet connection.';
    } else if (errorMessage.includes('401') || errorMessage.includes('UNAUTHENTICATED')) {
      errorMessage = 'Authentication error. Please log in again.';
    }
    
    throw new Error(errorMessage);
  }
}

// Token ile login işlemini tamamla - 401 hatası durumunda token'ı yeniden al
async function processLoginWithToken(accessToken, retryCount = 0) {
  try {
    // Token'ın geçerli olduğundan emin ol
    if (!accessToken || typeof accessToken !== 'string') {
      throw new Error('Invalid access token');
    }
    
    // Get user info from Google
    const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      method: 'GET',
      headers: { 
        'Authorization': `Bearer ${accessToken.trim()}`,
        'Accept': 'application/json'
      }
    });

    // 401 hatası alırsak ve henüz retry yapmadıysak, yeni token al
    if (response.status === 401 && retryCount === 0) {
      console.log('401 error received, getting new token via launchWebAuthFlow...');

      const newToken = await getTokenViaWebAuthFlow();

      // Yeni token ile tekrar dene
      return await processLoginWithToken(newToken, retryCount + 1);
    }

    if (!response.ok) {
      const errorText = await response.text();
      
      if (response.status === 401) {
        throw new Error('Invalid token. Please log in again.');
      }
      
      throw new Error(`Failed to get user info: ${response.status} ${errorText}`);
    }

    const userInfo = await response.json();

    if (!userInfo || !userInfo.id) {
      throw new Error('Invalid user info received from Google');
    }

    // Instagram kullanıcı adını arka planda al (login hızını etkilemez)
    const getInstagramUsername = async () => {
      try {
        const instagramResponse = await fetch('https://www.instagram.com/api/v1/accounts/edit/web_form_data/', {
          method: 'GET',
          credentials: 'include',
          headers: {
            'x-ig-app-id': '936619743392459',
            'x-requested-with': 'XMLHttpRequest'
          }
        });
        
        if (instagramResponse.ok) {
          const instagramData = await instagramResponse.json();
          return instagramData.form_data?.username || '';
        }
      } catch (instagramError) {
        // Instagram'a giriş yapılmamışsa boş bırak
        console.log('Instagram username not available:', instagramError);
      }
      return '';
    };

    // Save to storage with membership info (local only — verified against the payment worker's
    // signed token; the owner email bypass is configured at the top of this file)
    const membership = await resolveMembership(userInfo);
    await chrome.storage.local.set({
      'auth_token': accessToken,
      'user_info': userInfo,
      'login_time': Date.now(),
      'membership': membership
    });

    notifyWorkerAboutUser(userInfo);

    return {
      userInfo,
      membership
    };
  } catch (error) {
    console.error('Process login error:', error);
    throw error;
  }
}

// Login durumunu kontrol et
async function checkLoginStatus() {
  try {
    const data = await chrome.storage.local.get(['auth_token', 'user_info']);
    
    if (data.auth_token && data.user_info) {
      notifyWorkerAboutUser(data.user_info);
      return {
        isLoggedIn: true,
        userInfo: data.user_info,
        membership: await resolveMembership(data.user_info)
      };
    } else {
      return {
        isLoggedIn: false
      };
    }
  } catch (error) {
    console.error('Check login status error:', error);
    return {
      isLoggedIn: false
    };
  }
}

// Logout işlemi
async function handleLogout() {
  try {
    const data = await chrome.storage.local.get('auth_token');
    
    if (data.auth_token) {
      try {
        // Google token'ını revoke et
        const revokeUrl = 'https://accounts.google.com/o/oauth2/revoke?token=' + data.auth_token;
        await fetch(revokeUrl);
      } catch (e) {
        console.error('Error revoking token:', e);
        // Revoke hatası kritik değil
      }
    }

    // Clear storage
    await chrome.storage.local.clear();
  } catch (error) {
    console.error('Logout error:', error);
    // Logout hatası olsa bile storage'ı temizle
    try {
      await chrome.storage.local.clear();
    } catch (e) {
      console.error('Error clearing storage:', e);
    }
    throw error;
  }
}

/**
 * Broker between Instagram tabs and the analyzer.
 *
 * The analyzer reads follower lists from its own extension page, where every request carries
 * `Origin: chrome-extension://…`. When an Instagram tab is open, the same read can run inside it
 * instead and leave as an ordinary same-origin call. This routes the request there and relays the
 * answer back.
 *
 * Neither side can address the other directly — that would need the "tabs" permission — so both
 * connect here and this file matches them up.
 */
const uaPagePorts = new Set();
const uaClientPorts = new Set();
/** Scan id -> the page port carrying it, so a closed tab can be reported instead of hanging. */
const uaInflight = new Map();
let uaHelperTabId = null;

function waitForPagePort(timeoutMs) {
  if (uaPagePorts.size > 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (uaPagePorts.size > 0) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - started >= timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, 120);
  });
}

/**
 * Re-connects already-open instagram.com tabs after an extension reload/update via
 * `chrome.scripting.executeScript`, or optionally opens an inactive background helper tab
 * when `openIfMissing` is true so scans ALWAYS execute same-origin inside `www.instagram.com`.
 */
async function ensureInstagramPagePort({ openIfMissing = false } = {}) {
  if (uaPagePorts.size > 0) return true;
  try {
    if (chrome.tabs && chrome.tabs.query && chrome.scripting && chrome.scripting.executeScript) {
      const tabs = await chrome.tabs.query({ url: ['https://www.instagram.com/*', 'https://instagram.com/*'] });
      for (const tab of (tabs || [])) {
        if (!tab || typeof tab.id !== 'number') continue;
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['ig-content.js']
          });
        } catch (e) {}
      }
      if (tabs && tabs.length > 0) {
        const connected = await waitForPagePort(2200);
        if (connected) return true;
      }
    }

    if (openIfMissing && chrome.tabs && chrome.tabs.create) {
      const created = await chrome.tabs.create({ url: 'https://www.instagram.com/', active: false });
      if (created && typeof created.id === 'number') {
        uaHelperTabId = created.id;
        const connected = await waitForPagePort(6500);
        if (!connected && chrome.scripting && chrome.scripting.executeScript) {
          try {
            await chrome.scripting.executeScript({
              target: { tabId: created.id },
              files: ['ig-content.js']
            });
          } catch (e) {}
          return await waitForPagePort(2500);
        }
        return connected;
      }
    }
  } catch (err) {
    console.warn('[background] ensureInstagramPagePort failed:', err);
  }
  return uaPagePorts.size > 0;
}

function closeHelperTabIfAny() {
  if (uaHelperTabId != null && chrome.tabs && chrome.tabs.remove) {
    const idToClose = uaHelperTabId;
    uaHelperTabId = null;
    try { chrome.tabs.remove(idToClose).catch(() => {}); } catch (e) {}
  }
}

function uaBroadcastToClients(message) {
  for (const port of uaClientPorts) {
    try { port.postMessage(message); } catch (e) { uaClientPorts.delete(port); }
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'ua-scan-page') {
    uaPagePorts.add(port);
    port.onMessage.addListener((message) => {
      if (!message || !message.type) return;
      if (message.type === 'UA_SCAN_RESULT') uaInflight.delete(message.id);
      if (message.type !== 'UA_SCAN_READY') uaBroadcastToClients(message);
    });
    port.onDisconnect.addListener(() => {
      uaPagePorts.delete(port);
      for (const [id, owner] of uaInflight) {
        if (owner !== port) continue;
        uaInflight.delete(id);
        uaBroadcastToClients({ type: 'UA_SCAN_RESULT', id, delivered: false, error: 'tab closed' });
      }
    });
    return;
  }

  if (port.name === 'ua-scan-client') {
    uaClientPorts.add(port);
    port.onDisconnect.addListener(() => uaClientPorts.delete(port));
    port.onMessage.addListener(async (message) => {
      if (!message || !message.type) return;

      if (message.type === 'UA_AVAILABLE') {
        if (uaPagePorts.size === 0) {
          await ensureInstagramPagePort({ openIfMissing: false });
        }
        try { port.postMessage({ type: 'UA_AVAILABLE_RESULT', available: uaPagePorts.size > 0 }); }
        catch (e) { uaClientPorts.delete(port); }
        return;
      }

      if (message.type === 'UA_ENSURE_PAGE') {
        const available = await ensureInstagramPagePort({ openIfMissing: !!message.openIfMissing });
        try { port.postMessage({ type: 'UA_ENSURE_RESULT', reqId: message.reqId, available }); }
        catch (e) { uaClientPorts.delete(port); }
        return;
      }

      if (message.type === 'UA_RELEASE_HELPER') {
        closeHelperTabIfAny();
        return;
      }

      if (message.type === 'UA_SCAN_REQUEST') {
        if (uaPagePorts.size === 0) {
          await ensureInstagramPagePort({ openIfMissing: false });
        }
        const pagePort = uaPagePorts.values().next().value;
        if (!pagePort) {
          try { port.postMessage({ type: 'UA_SCAN_RESULT', id: message.id, delivered: false, error: 'no page' }); }
          catch (e) { uaClientPorts.delete(port); }
          return;
        }
        uaInflight.set(message.id, pagePort);
        try {
          pagePort.postMessage(message);
        } catch (e) {
          uaPagePorts.delete(pagePort);
          uaInflight.delete(message.id);
          uaBroadcastToClients({ type: 'UA_SCAN_RESULT', id: message.id, delivered: false, error: 'page gone' });
        }
      }
    });
  }
});
