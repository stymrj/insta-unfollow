// Background Service Worker - Login with new tab method
// This method completely solves the popup closing issue and works on all platforms

// Owner bypass: this Google account is always premium, no payment needed.
const PREMIUM_ADMIN_EMAIL = 'sstymrj@gmail.com';
// Everyone premium until the payment worker is deployed and selling starts.
const PREMIUM_BY_DEFAULT = true;
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

/** v1.<payload-b64url>.<signature-b64url> — returns true only for a valid, unexpired token. */
async function verifyPremiumToken(token) {
  if (typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64urlDecode(parts[1])));
  } catch (error) {
    return false;
  }
  if (!payload || typeof payload.exp !== 'number' || Date.now() > payload.exp) return false;
  try {
    const key = await crypto.subtle.importKey('raw', hexToBytes(PREMIUM_PUBLIC_KEY), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, base64urlDecode(parts[2]), base64urlDecode(parts[1]));
  } catch (error) {
    console.error('Premium token verification failed:', error);
    return false;
  }
}

/**
 * The membership a login/status check should report: a verified signed token wins,
 * then the owner email, otherwise free. Hand-edited storage no longer counts as premium.
 */
async function resolveMembership(userInfo) {
    if (PREMIUM_BY_DEFAULT) {
      return { uye_id: userInfo && userInfo.id, turu: 'premium' };
    }
    const stored = await chrome.storage.local.get('membership');
  const m = stored.membership || {};
  if (m.turu === 'premium' && m.token && await verifyPremiumToken(m.token)) {
    return m;
  }
  if (userInfo && userInfo.email && userInfo.email.toLowerCase() === PREMIUM_ADMIN_EMAIL.toLowerCase()) {
    return { ...m, uye_id: userInfo.id, turu: 'premium' };
  }
  return { uye_id: userInfo && userInfo.id, turu: 'free', kayit_tarihi: new Date().toISOString() };
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
      // A tab closed or navigated away mid-read. Say so, otherwise the analyzer waits forever
      // for an answer that is never coming instead of reading the list itself.
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
    port.onMessage.addListener((message) => {
      if (!message || !message.type) return;

      if (message.type === 'UA_AVAILABLE') {
        try { port.postMessage({ type: 'UA_AVAILABLE_RESULT', available: uaPagePorts.size > 0 }); }
        catch (e) { uaClientPorts.delete(port); }
        return;
      }

      if (message.type === 'UA_SCAN_REQUEST') {
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
