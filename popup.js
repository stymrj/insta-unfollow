// i18n helper function
function getMessage(key, substitutions) {
    return chrome.i18n.getMessage(key, substitutions) || key;
}

// Initialize i18n for all elements with data-i18n attribute
function initializeI18n() {
    document.querySelectorAll('[data-i18n]').forEach(element => {
        const key = element.getAttribute('data-i18n');
        const paramsAttr = element.getAttribute('data-i18n-params');
        let substitutions = null;
        
        if (paramsAttr) {
            try {
                const params = JSON.parse(paramsAttr);
                // Extract values from params object
                substitutions = Object.values(params);
            } catch (e) {
                console.error('Error parsing i18n params:', e);
            }
        }
        
        const message = getMessage(key, substitutions);
        if (message && message !== key) {
            // Handle placeholder replacement for messages with $COUNT$, $1, etc.
            let finalMessage = message;
            if (paramsAttr) {
                try {
                    const params = JSON.parse(paramsAttr);
                    // Replace $COUNT$ with actual value
                    if (params.count) {
                        finalMessage = finalMessage.replace(/\$COUNT\$/g, params.count);
                    }
                    // Replace $1, $2, etc. with actual values
                    const values = Object.values(params);
                    values.forEach((val, index) => {
                        finalMessage = finalMessage.replace(new RegExp(`\\$${index + 1}`, 'g'), val);
                    });
                } catch (e) {
                    console.error('Error processing i18n params:', e);
                }
            }
            element.textContent = finalMessage;
        }
    });
}

// Function to update subscription button visibility based on login state
function updateSubscribeButtonVisibility(isLoggedIn) {
    const subscribeButton = document.getElementById('subscribeButton');
    const loginMessage = document.getElementById('loginMessage');
    
    if (isLoggedIn) {
        subscribeButton.style.display = 'block';
        loginMessage.style.display = 'none';
    } else {
        subscribeButton.style.display = 'none';
        loginMessage.style.display = 'block';
    }
}

document.addEventListener('DOMContentLoaded', function() {
    // Initialize i18n
    initializeI18n();
    
    // Event Listeners
    document.getElementById('googleLoginBtn').addEventListener('click', handleGoogleLogin);
    
    // Gmail login required button
    const gmailLoginRequiredBtn = document.getElementById('gmailLoginRequiredBtn');
    if (gmailLoginRequiredBtn) {
        gmailLoginRequiredBtn.addEventListener('click', handleGoogleLogin);
    }
    
    // Check login status first
    checkLoginStatus().then(() => {
        // After login check, setup menu and other features
        setupMenuAndContent();
    });

    // Event listener for Instagram login redirect button
    const loginRedirectBtn = document.getElementById('loginRedirectBtn');
    if (loginRedirectBtn) {
        loginRedirectBtn.addEventListener('click', function() {
            chrome.tabs.create({ url: 'https://www.instagram.com/accounts/login/' });
        });
    }

    // Retries the check in place. Sending a throttled user to the login page would be sending them
    // somewhere that cannot help; the only useful action is to wait and look again.
    const limitedRetryBtn = document.getElementById('limitedRetryBtn');
    if (limitedRetryBtn) {
        limitedRetryBtn.addEventListener('click', function() {
            document.getElementById('instagramLimitedAlert').style.display = 'none';
            checkInstagramLogin();
        });
    }
});

function setupMenuAndContent() {
    // Bot scan lives on its own page for the same reason the analyzer does: a scored table with
    // the reasons beside every row does not fit a 580px popup.
    const openBotScan = document.getElementById('openBotScan');
    if (openBotScan) {
        openBotScan.addEventListener('click', () => {
            chrome.tabs.create({ url: chrome.runtime.getURL('bot-scan.html') });
            window.close();
        });
    }

    // The admin console also runs on its own page; only the owner's email may open it.
    const openAdminPanel = document.getElementById('openAdminPanel');
    if (openAdminPanel) {
        openAdminPanel.addEventListener('click', () => {
            chrome.tabs.create({ url: chrome.runtime.getURL('admin.html') });
            window.close();
        });
    }

    const menuItems = document.querySelectorAll('.menu-item');
    const contentSections = document.querySelectorAll('.content-section');

    menuItems.forEach(item => {
        item.addEventListener('click', function(e) {
            e.preventDefault();
            
            const page = this.dataset.page || this.querySelector('span').textContent.toLowerCase();
            
            // Check if user is logged in
            chrome.storage.local.get(['auth_token', 'user_info'], (data) => {
                if (!data.auth_token || !data.user_info) {
                    // Show login required screen
                    showGmailLoginRequired();
                    return;
                }
            });
            
            // Remove active class from all menu items
            menuItems.forEach(i => i.classList.remove('active'));
            
            // Add active class to clicked menu item
            this.classList.add('active');

            // Hide all content sections
            contentSections.forEach(section => {
                section.style.display = 'none';
            });

            // Show the corresponding content section
            const targetContent = document.getElementById(page + 'Content');
            if (targetContent) {
                targetContent.style.display = 'block';
            }
        });
    });

    // Show home content by default
    document.getElementById('homeContent').style.display = 'block';
    document.querySelectorAll('.content-section:not(#homeContent)').forEach(section => {
        section.style.display = 'none';
    });

    const logoutButtons = document.querySelectorAll('.logout-btn');
    if (logoutButtons.length > 0) {
        logoutButtons.forEach(button => {
            button.addEventListener('click', function() {
                handleLogout();
            });
        });
    } else {
        console.error('No logout buttons found');
    }

    const subscribeButton = document.getElementById('subscribeButton');
    if (subscribeButton) {
        subscribeButton.addEventListener('click', async function() {
            const membership = await getPremiumMembership();
            if (membership.turu === 'premium') {
                showSuccessMessage(getMessage('premiumUnlockAllMessage'));
                return;
            }
            try {
                const data = await chrome.storage.local.get(['user_info']);
                const userId = (data.user_info && data.user_info.id) || '';
                const response = await fetch(window.PAYMENT_API_URL + '/create-link', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ plan: 'monthly', userId })
                });
                const payload = await response.json().catch(() => ({}));
                if (!response.ok || !payload.short_url) {
                    throw new Error(payload.error || ('payment link failed: ' + response.status));
                }
                window.open(payload.short_url, '_blank');
                showSuccessMessage('Complete the payment in the opened tab. Premium activates once the payment is confirmed.');
            } catch (error) {
                console.error('Payment link failed:', error);
                showErrorMessage('Payment link unavailable. Set PAYMENT_API_URL in premium-config.js.');
            }
        });
    }

    // Analyze butonuna tıklandığında Instagram kontrolü yap
    const analyzeBtn = document.getElementById('analyzeBtn');
    if (analyzeBtn) {
        analyzeBtn.addEventListener('click', function() {
            // Check if user is logged in
            chrome.storage.local.get(['auth_token', 'user_info'], (data) => {
                if (!data.auth_token || !data.user_info) {
                    showGmailLoginRequired();
                    return;
                }
                
                // Open analyzer.html in new tab
                chrome.tabs.create({
                    url: chrome.runtime.getURL('analyzer.html')
                });
                
                // Close current popup
                window.close();
            });
        });
    }
}

// The Admin menu item is only for the account listed as PREMIUM_ADMIN_EMAIL.
function setupAdminEntry() {
    const item = document.getElementById('adminMenuItem');
    if (!item) return;
    chrome.storage.local.get(['user_info'], (data) => {
        const email = data.user_info && data.user_info.email;
        const adminEmail = window.PREMIUM_ADMIN_EMAIL || '';
        item.style.display = email && adminEmail && email.toLowerCase() === adminEmail.toLowerCase() ? '' : 'none';
    });
}

// Show Gmail login required screen
function showGmailLoginRequired() {
    const gmailLoginRequired = document.getElementById('gmailLoginRequired');
    const mainContent = document.getElementById('mainContent');
    const menuItems = document.querySelectorAll('.menu-item');
    
    if (gmailLoginRequired) {
        gmailLoginRequired.style.display = 'flex';
    }
    if (mainContent) {
        mainContent.style.display = 'none';
    }
    
    // Disable menu items
    menuItems.forEach(item => {
        item.style.pointerEvents = 'none';
        item.style.opacity = '0.5';
    });
}

// Hide Gmail login required screen and show main content
function hideGmailLoginRequired() {
    const gmailLoginRequired = document.getElementById('gmailLoginRequired');
    const mainContent = document.getElementById('mainContent');
    const menuItems = document.querySelectorAll('.menu-item');
    
    if (gmailLoginRequired) {
        gmailLoginRequired.style.display = 'none';
    }
    if (mainContent) {
        mainContent.style.display = 'block';
    }
    
    // Enable menu items
    menuItems.forEach(item => {
        item.style.pointerEvents = 'auto';
        item.style.opacity = '1';
    });
}

// Google Login - Send message to background service worker (new tab method)
async function handleGoogleLogin() {
    const loginBtn = document.getElementById('googleLoginBtn');
    const logoutBtn = document.getElementById('logoutBtn');
    const gmailLoginRequiredBtn = document.getElementById('gmailLoginRequiredBtn');
    
    try {
        // Show loading state
        if (loginBtn) {
            loginBtn.textContent = getMessage('opening');
            loginBtn.disabled = true;
        }
        
        if (gmailLoginRequiredBtn) {
            gmailLoginRequiredBtn.disabled = true;
            const span = gmailLoginRequiredBtn.querySelector('span');
            if (span) {
                span.textContent = getMessage('openingInNewTab');
            }
        }

        // Send login request to background service worker
        // New tab will open, login continues even if popup closes
        const response = await chrome.runtime.sendMessage({ action: 'googleLogin' });
        
        if (!response) {
            throw new Error('No response from background service');
        }
        
        if (response.success) {
            const { userInfo, membership } = response.data;

            // UI'ı güncelle
            updateUIAfterLogin(userInfo, membership);
            
            // Hide login required screen and show main content
            hideGmailLoginRequired();
            
            // Instagram kontrolünü başlat
            checkInstagramLogin();
            
            // Show success message
            showSuccessMessage(getMessage('loginSuccessful'));
        } else {
            throw new Error(response.error || getMessage('unknownError'));
        }
    } catch (error) {
        console.error('Login error:', error);
        
        // Reset UI
        resetLoginUI(loginBtn, logoutBtn, gmailLoginRequiredBtn);
        
        // Show error message
        showErrorMessage(getMessage('loginFailed', [error.message || getMessage('unknownError')]));
        updateSubscribeButtonVisibility(false);
    }
}

// UI güncelleme fonksiyonu
async function updateUIAfterLogin(userInfo, membership) {
    // Never trust the caller's membership: re-verify the signed token / owner bypass.
    membership = await getPremiumMembership();
    const loginBtn = document.getElementById('googleLoginBtn');
    const logoutBtn = document.getElementById('logoutBtn');
    const gmailLoginRequiredBtn = document.getElementById('gmailLoginRequiredBtn');
    
    // Remove loading state
    if (gmailLoginRequiredBtn) {
        gmailLoginRequiredBtn.disabled = false;
        const span = gmailLoginRequiredBtn.querySelector('span');
        if (span) {
            span.textContent = getMessage('loginWithGoogle');
        }
    }
    
    // Hide login button and show user info container
    if (loginBtn) {
        loginBtn.style.display = 'none';
    }
    
    // Update user info container
    const userInfoContainer = document.getElementById('userInfoContainer');
    if (userInfoContainer) {
        const avatar = document.getElementById('userInfoAvatar');
        const name = document.getElementById('userInfoName');
        const badge = document.getElementById('userInfoBadge');
        
        if (avatar) avatar.src = userInfo.picture || '';
        if (name) name.textContent = userInfo.given_name || userInfo.name || userInfo.email || '';
        
        if (badge) {
            const isPremium = membership.turu === 'premium' || membership.turu === 'Premium';
            badge.textContent = isPremium ? getMessage('planPremium') : getMessage('planFree');
            badge.className = `user-info-badge ${isPremium ? 'premium' : 'free'}`;
        }
        
        userInfoContainer.style.display = 'flex';
    }
    
    // Update logout button
    if (logoutBtn) {
        logoutBtn.style.display = 'flex';
    }

    // Update subscribe button
    updateSubscribeButtonVisibility(true);

    // Show the admin menu item for the owner account
    setupAdminEntry();

    const subscribeButton = document.getElementById('subscribeButton');
    if (subscribeButton) {
        const isPremium = membership.turu === 'premium' || membership.turu === 'Premium';
        if (isPremium) {
            subscribeButton.textContent = getMessage('manageSubscription');
        } else {
            subscribeButton.textContent = getMessage('upgradeToPremium');
        }
    }

}

// Reset login UI
function resetLoginUI(loginBtn, logoutBtn, gmailLoginRequiredBtn) {
    // Hide user info container and show login button
    const userInfoContainer = document.getElementById('userInfoContainer');
    if (userInfoContainer) {
        userInfoContainer.style.display = 'none';
    }
    
    if (loginBtn) {
        loginBtn.innerHTML = `
            <svg class="google-icon" width="18" height="18" viewBox="0 0 18 18">
                <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"/>
                <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z"/>
                <path fill="#FBBC05" d="M3.964 10.707c-.18-.54-.282-1.117-.282-1.707s.102-1.167.282-1.707V4.961H.957C.347 6.192 0 7.56 0 9s.348 2.808.957 4.039l3.007-2.332z"/>
                <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.961L3.964 7.293C4.672 5.166 6.656 3.58 9 3.58z"/>
            </svg>
            <span>${getMessage('login')}</span>
        `;
        loginBtn.style.display = 'flex';
        loginBtn.disabled = false;
    }
    
    if (gmailLoginRequiredBtn) {
        gmailLoginRequiredBtn.disabled = false;
        const span = gmailLoginRequiredBtn.querySelector('span');
        if (span) {
            span.textContent = getMessage('loginWithGoogle');
        }
    }
    
    if (logoutBtn) {
        logoutBtn.style.display = 'none';
    }
}

// Show success message
function showSuccessMessage(message) {
    const successDiv = document.createElement('div');
    successDiv.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: #22c55e;
        color: white;
        padding: 12px 20px;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(34, 197, 94, 0.3);
        z-index: 10000;
        font-size: 14px;
        max-width: 300px;
        animation: slideIn 0.3s ease;
    `;
    successDiv.textContent = message;
    document.body.appendChild(successDiv);
    
    setTimeout(() => {
        successDiv.style.animation = 'slideOut 0.3s ease';
        setTimeout(() => {
            successDiv.remove();
        }, 300);
    }, 3000);
}

// Show error message
function showErrorMessage(message) {
    const errorDiv = document.createElement('div');
    errorDiv.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: #ef4444;
        color: white;
        padding: 12px 20px;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(239, 68, 68, 0.3);
        z-index: 10000;
        font-size: 14px;
        max-width: 300px;
        animation: slideIn 0.3s ease;
    `;
    errorDiv.textContent = message;
    document.body.appendChild(errorDiv);
    
    setTimeout(() => {
        errorDiv.style.animation = 'slideOut 0.3s ease';
        setTimeout(() => {
            errorDiv.remove();
        }, 300);
    }, 5000);
}

// Logout işlemi - Background service worker'a mesaj gönder
async function handleLogout() {
    const loginBtn = document.getElementById('googleLoginBtn');
    const logoutBtn = document.getElementById('logoutBtn');
    
    try {
        // Disable logout button
        if (logoutBtn) {
            logoutBtn.disabled = true;
        }
        
        // Send logout request to background service worker
        const response = await chrome.runtime.sendMessage({ action: 'logout' });
        
        if (response && response.success) {
            // Update UI
            if (loginBtn) {
                loginBtn.innerHTML = `
                    <svg class="google-icon" width="18" height="18" viewBox="0 0 18 18">
                        <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"/>
                        <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z"/>
                        <path fill="#FBBC05" d="M3.964 10.707c-.18-.54-.282-1.117-.282-1.707s.102-1.167.282-1.707V4.961H.957C.347 6.192 0 7.56 0 9s.348 2.808.957 4.039l3.007-2.332z"/>
                        <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.961L3.964 7.293C4.672 5.166 6.656 3.58 9 3.58z"/>
                    </svg>
                    <span>${getMessage('login')}</span>
                `;
                loginBtn.style.display = 'flex';
            }
            
            if (logoutBtn) {
                logoutBtn.style.display = 'none';
                logoutBtn.disabled = false;
            }

            // Logout olduğunda subscribe butonunu gizle
            updateSubscribeButtonVisibility(false);
            
            // Show login required screen
            showGmailLoginRequired();

            // Reload the page
            window.location.reload();
        } else {
            throw new Error(response?.error || getMessage('unknownError'));
        }
    } catch (error) {
        console.error('Logout error:', error);
        
        // Reset logout button
        if (logoutBtn) {
            logoutBtn.disabled = false;
        }
        
        showErrorMessage(getMessage('logoutError', [error.message || getMessage('unknownError')]));
    }
}

// Check login status on startup - Send message to background service worker
async function checkLoginStatus() {
    // İlk loading ekranını göster
    const initialLoading = document.getElementById('initialLoading');
    const gmailLoginRequired = document.getElementById('gmailLoginRequired');
    const mainContent = document.getElementById('mainContent');
    
    if (initialLoading) {
        initialLoading.style.display = 'flex';
    }
    if (gmailLoginRequired) {
        gmailLoginRequired.style.display = 'none';
    }
    if (mainContent) {
        mainContent.style.display = 'none';
    }
    
    try {
        const loginBtn = document.getElementById('googleLoginBtn');
        const logoutBtn = document.getElementById('logoutBtn');
        
        // Background service worker'a login durumu kontrol isteği gönder
        const response = await chrome.runtime.sendMessage({ action: 'checkLoginStatus' });
        
        if (response && response.success && response.data.isLoggedIn) {
            const { userInfo, membership } = response.data;

            // Loading ekranını gizle
            if (initialLoading) {
                initialLoading.style.display = 'none';
            }

            // Hide login required screen and show main content
            hideGmailLoginRequired();
            
            // Update UI - new structure
            if (loginBtn) {
                loginBtn.style.display = 'none';
            }
            
            // Show the admin menu item for the owner account
            setupAdminEntry();
            
            // Update user info container
            const userInfoContainer = document.getElementById('userInfoContainer');
            if (userInfoContainer) {
                const avatar = document.getElementById('userInfoAvatar');
                const name = document.getElementById('userInfoName');
                const badge = document.getElementById('userInfoBadge');
                
                if (avatar) avatar.src = userInfo.picture || '';
                if (name) name.textContent = userInfo.given_name || userInfo.name || userInfo.email || '';
                
                if (badge) {
                    const isPremium = membership.turu === 'premium' || membership.turu === 'Premium';
                    badge.textContent = isPremium ? getMessage('planPremium') : getMessage('planFree');
                    badge.className = `user-info-badge ${isPremium ? 'premium' : 'free'}`;
                }
                
                userInfoContainer.style.display = 'flex';
            }
            
            if (logoutBtn) {
                logoutBtn.style.display = 'flex';
            }

            // Login durumunu güncelle
            updateSubscribeButtonVisibility(true);
            
            // Update subscribe button text based on premium status
            const subscribeButton = document.getElementById('subscribeButton');
            if (subscribeButton) {
                const isPremium = membership.turu === 'premium' || membership.turu === 'Premium';
                if (isPremium) {
                    subscribeButton.textContent = getMessage('manageSubscription');
                } else {
                    subscribeButton.textContent = getMessage('upgradeToPremium');
                }
            }
            
            // Instagram kontrolünü başlat
            checkInstagramLogin();
        } else {
            // Loading ekranını gizle ve login ekranını göster
            const initialLoading = document.getElementById('initialLoading');
            if (initialLoading) {
                initialLoading.style.display = 'none';
            }
            
            // Show Gmail login required screen
            showGmailLoginRequired();
            if (loginBtn) {
                loginBtn.style.display = 'flex';
            }
            if (logoutBtn) {
                logoutBtn.style.display = 'none';
            }
            // Logout durumunu güncelle
            updateSubscribeButtonVisibility(false);
        }
    } catch (error) {
        console.error('Check login status error:', error);
        updateSubscribeButtonVisibility(false);
        showGmailLoginRequired();
    }
}



function fetchPrices() {
  // Static pricing — no external server
  document.getElementById('oldPrice').textContent = '$25';
  document.getElementById('newPrice').textContent = '$6.99';
}

// Call this function when the popup loads
document.addEventListener('DOMContentLoaded', fetchPrices);

function showLoading() {
  document.getElementById('loadingSpinner').style.display = 'flex';
  document.getElementById('instagramInfo').style.display = 'none';
  document.getElementById('instagramLoginAlert').style.display = 'none';
  const limited = document.getElementById('instagramLimitedAlert');
  if (limited) limited.style.display = 'none';
}

function hideLoading() {
  document.getElementById('loadingSpinner').style.display = 'none';
}

/**
 * Read a response, telling "Instagram declined" apart from "something is broken".
 *
 * A throttled account is refused with 200 and an HTML login page, not a 4xx — so `response.ok` is
 * true and only the JSON parse gives it away. Every failure in the check below used to land in one
 * catch and show "Please login to Instagram first", which is how a signed-in user whose account was
 * being rate-limited got told to sign in. They then open Instagram, find themselves logged in, and
 * conclude the extension is broken.
 *
 * @returns {Promise<{data: object|null, refused: boolean, expired: boolean}>}
 */
async function readIgJson(response) {
  // The only two codes that actually mean "your session is not valid".
  if (response.status === 401 || response.status === 403) {
    return { data: null, refused: false, expired: true };
  }
  // Too many requests, or Instagram having trouble. Neither is a sign-in problem.
  if (response.status === 429 || response.status >= 500) {
    return { data: null, refused: true, expired: false };
  }
  const text = await response.text();
  try {
    return { data: JSON.parse(text), refused: false, expired: false };
  } catch (error) {
    // 200 carrying HTML: the refusal signature.
    return { data: null, refused: true, expired: false };
  }
}

/** Instagram is holding us off — nothing is wrong with the account or the sign-in. */
function showInstagramLimitedAlert() {
  const infoDiv = document.getElementById('instagramInfo');
  const loginDiv = document.getElementById('instagramLoginAlert');
  const limitDiv = document.getElementById('instagramLimitedAlert');
  if (infoDiv) infoDiv.style.display = 'none';
  if (loginDiv) loginDiv.style.display = 'none';
  if (limitDiv) limitDiv.style.display = 'block';
}

async function checkInstagramLogin() {
  try {
    showLoading(); // Show loading

    /*
     * shared_data comes first, and it decides whether the user is signed in. Nothing else can.
     *
     * A signed-out browser is sent an HTML login page with status 200 — byte-for-byte the same
     * shape as a throttled refusal. So "200 carrying HTML" cannot tell the two apart, and reading
     * it as throttling told a signed-out user their account was being rate limited.
     *
     * This endpoint is the exception: it answers with JSON either way, and simply leaves
     * `config.viewer` empty when nobody is signed in. That makes it the one reliable test, so it
     * runs first and everything after it is interpreted in light of its answer.
     */
    const sharedFirst = await fetch('https://www.instagram.com/data/shared_data/', {
      method: 'GET',
      credentials: 'include'
    });
    const shared = await readIgJson(sharedFirst);

    if (shared.expired) {
      hideLoading();
      showInstagramLoginAlert();
      hideAnalyzeButton();
      return;
    }
    // Even a signed-out visitor gets JSON here, so a non-JSON body means Instagram is refusing us
    // outright — that really is throttling, not a sign-in problem.
    if (shared.refused || !shared.data) {
      hideLoading();
      showInstagramLimitedAlert();
      return;
    }

    const viewerId = shared.data?.config?.viewer?.id;
    if (!viewerId) {
      // JSON arrived and there is no viewer in it. This is the one honest "please sign in".
      hideLoading();
      showInstagramLoginAlert();
      hideAnalyzeButton();
      return;
    }

    // From here the user is known to be signed in, so any refusal below is throttling.
    const userResponse = await fetch('https://www.instagram.com/api/v1/accounts/edit/web_form_data/', {
      method: 'GET',
      credentials: 'include',
      headers: {
        'x-ig-app-id': '936619743392459',
        'x-requested-with': 'XMLHttpRequest'
      }
    });

    const userForm = await readIgJson(userResponse);
    if (userForm.refused || userForm.expired) {
      hideLoading();
      showInstagramLimitedAlert();
      return;
    }

    const username = userForm.data && userForm.data.form_data && userForm.data.form_data.username;

    // Profil bilgilerini al.
    //
    // web_profile_info was used here, but Instagram now answers 400 when it is asked for the
    // viewer's own username — it still works for other people's usernames, which is why the
    // unfollow flow in analyzer.js is unaffected. users/{id}/info/ returns the same three fields
    // and answers for one's own account. The viewer id comes from the shared_data call above.
    const profileResponse = await fetch(`https://www.instagram.com/api/v1/users/${viewerId}/info/`, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'x-ig-app-id': '936619743392459',
        'x-requested-with': 'XMLHttpRequest'
      }
    });

    const profile = await readIgJson(profileResponse);
    if (profile.refused) {
      hideLoading();
      showInstagramLimitedAlert();
      return;
    }

    const user = profile.data && profile.data.user;
    if (!user) {
      throw new Error('No user in profile response');
    }

    // Use the profile picture URL directly
    const originalProfileUrl = user.profile_pic_url;

    updateInstagramUI({
      isLoggedIn: true,
      username: user.username || username,
      followers: (user.follower_count ?? 0).toLocaleString(),
      following: (user.following_count ?? 0).toLocaleString(),
      profileImage: originalProfileUrl
    });

  } catch (error) {
    // Kept visible on purpose: without the real reason in the console, an endpoint change is
    // indistinguishable from a genuinely signed-out user.
    console.error('checkInstagramLogin failed:', error);
    hideLoading();

    // A fetch that rejects never reached Instagram at all — the connection dropped. That is not a
    // sign-in problem either, and the retry button is the useful thing to offer.
    if (error instanceof TypeError) showInstagramLimitedAlert();
    else showInstagramLoginAlert();

    hideAnalyzeButton();
  }
}

function updateInstagramUI(data) {
  hideLoading(); // Loading'i gizle
  
  const infoDiv = document.getElementById('instagramInfo');
  const alertDiv = document.getElementById('instagramLoginAlert');
  
  if (data.isLoggedIn) {
    // Profil resmini güncelle
    const profileImage = document.getElementById('profileImage');
    profileImage.src = data.profileImage;
    loadAvatar(profileImage, data.profileImage);
    
    // Update other information
    document.getElementById('igUsername').textContent = data.username;
    document.getElementById('igFollowers').textContent = data.followers;
    document.getElementById('igFollowing').textContent = data.following;
    
    infoDiv.style.display = 'block';
    alertDiv.style.display = 'none';
  } else {
    showInstagramLoginAlert();
  }
}

function hideAnalyzeButton() {
  const analyzeBtn = document.getElementById('analyzeBtn');
  if (analyzeBtn) {
    analyzeBtn.style.display = 'none';
  }
}

// Login uyarısını göster
function showInstagramLoginAlert() {
  const infoDiv = document.getElementById('instagramInfo');
  const alertDiv = document.getElementById('instagramLoginAlert');
  
  infoDiv.style.display = 'none';
  alertDiv.style.display = 'block';
}

/**
 * Instagram CDN avatars refuse foreign pages, so the extension page fetches them itself
 * (host_permissions for *.cdninstagram.com/* bypass CORS here) and hands the element an
 * object URL. The direct src attempt stays first; the element's onerror fallback still applies.
 */
const popupAvatarCache = new Map();
const popupAvatarOrder = [];

function loadAvatar(img, url) {
  if (!img || !url) return;
  const state = popupAvatarCache.get(url);
  if (state === 'pending') return;
  if (state) {
    img.src = state;
    return;
  }
  popupAvatarCache.set(url, 'pending');
  fetch(url, { credentials: 'omit', mode: 'cors' })
    .then((response) => {
      if (!response.ok) throw new Error(String(response.status));
      return response.blob();
    })
    .then((blob) => {
      if (!blob.type.startsWith('image/')) throw new Error('not an image');
      const objectUrl = URL.createObjectURL(blob);
      popupAvatarCache.set(url, objectUrl);
      popupAvatarOrder.push(url);
      if (popupAvatarOrder.length > 300) {
        const oldest = popupAvatarOrder.shift();
        const evicted = popupAvatarCache.get(oldest);
        if (typeof evicted === 'string') URL.revokeObjectURL(evicted);
        popupAvatarCache.delete(oldest);
      }
      img.src = objectUrl;
    })
    .catch(() => {
      popupAvatarCache.delete(url);
    });
}
