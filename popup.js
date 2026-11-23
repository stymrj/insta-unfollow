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

// Premium expiry as "12 Dec 2026" (en-IN, day month year), or null when unknown.
function formatPremiumExpiry(expiry) {
    if (!expiry) return null;
    const date = new Date(expiry);
    if (isNaN(date.getTime())) return null;
    return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

// The header badge is the popup's premium-status element: "Premium" / "Free", and
// "Premium until <date>" while a dated premium membership is active.
function setPremiumBadge(badge, membership) {
    if (!badge) return;
    membership = membership || { turu: 'free' };
    const isPremium = membership.turu === 'premium' || membership.turu === 'Premium';
    const expiryText = isPremium ? formatPremiumExpiry(membership.expiry) : null;
    badge.textContent = expiryText
        ? 'Premium until ' + expiryText
        : (isPremium ? getMessage('planPremium') : getMessage('planFree'));
    badge.className = `user-info-badge ${isPremium ? 'premium' : 'free'}`;
}

// Function to update subscription button visibility based on login state
function updateSubscribeButtonVisibility(isLoggedIn) {
    const subscribeButton = document.getElementById('subscribeButton');
    const planPicker = document.getElementById('popupPlanPicker');
    const loginMessage = document.getElementById('loginMessage');

    if (isLoggedIn) {
        if (subscribeButton) subscribeButton.style.display = 'block';
        if (planPicker) planPicker.style.display = 'block';
        if (loginMessage) loginMessage.style.display = 'none';
    } else {
        if (subscribeButton) subscribeButton.style.display = 'none';
        if (planPicker) planPicker.style.display = 'none';
        if (loginMessage) loginMessage.style.display = 'block';
    }
}

// --- Plan picker: the same five plans as the premium modal, from the shared
// definition in premium-config.js. Default selected plan: 1 month. The
// picker sits before the payment step; the selected plan drives the method
// picker, UPI view and proof form exactly as the modal does.

let popupSelectedPlan = '1mo';

function getPopupSelectedPlan() {
    if (typeof window.getPremiumPlan === 'function') {
        return window.getPremiumPlan(popupSelectedPlan).key;
    }
    return popupSelectedPlan || '1mo';
}

function updatePopupContinueButton() {
    const button = document.getElementById('subscribeButton');
    if (!button) return;
    if (typeof window.getPremiumPlan !== 'function') return;
    const plan = window.getPremiumPlan(popupSelectedPlan);
    button.textContent = 'Continue — ' + plan.label + ' · ₹' + plan.price;
}

function setPopupSelectedPlan(planKey) {
    popupSelectedPlan = typeof window.getPremiumPlan === 'function'
        ? window.getPremiumPlan(planKey).key : (planKey || '1mo');
    renderPopupPlanPicker();
}

function renderPopupPlanPicker() {
    const picker = document.getElementById('popupPlanPicker');
    if (!picker || !Array.isArray(window.PREMIUM_PLANS)) return;
    picker.innerHTML = '';
    window.PREMIUM_PLANS.forEach((plan) => {
        const selected = plan.key === getPopupSelectedPlan();
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.setAttribute('data-plan', plan.key);
        btn.setAttribute('role', 'radio');
        btn.setAttribute('aria-checked', selected ? 'true' : 'false');
        btn.style.cssText = 'display:grid;grid-template-columns:1fr auto;grid-template-areas:' +
            '"duration price" "save per-month";align-items:center;gap:2px 10px;width:100%;' +
            'padding:9px 12px;margin:0 0 6px;background:' + (selected ? '#eff6ff' : '#fff') + ';' +
            'border:1.5px solid ' + (selected ? '#2563eb' : '#e5e5e5') + ';border-radius:10px;' +
            'color:#262626;font-family:inherit;text-align:left;cursor:pointer;box-sizing:border-box;';
        const duration = document.createElement('span');
        duration.textContent = plan.label;
        duration.style.cssText = 'grid-area:duration;font-size:13px;font-weight:700;';
        const price = document.createElement('span');
        price.style.cssText = 'grid-area:price;display:flex;align-items:baseline;gap:6px;' +
            'font-size:15px;font-weight:700;justify-self:end;';
        if (plan.strike != null) {
            const strike = document.createElement('span');
            strike.textContent = '₹' + plan.strike;
            strike.style.cssText = 'text-decoration:line-through;color:#8e8e8e;font-size:12px;font-weight:500;';
            price.appendChild(strike);
        }
        const current = document.createElement('span');
        current.textContent = '₹' + plan.price;
        current.style.color = '#2563eb';
        price.appendChild(current);
        const save = document.createElement('span');
        save.textContent = plan.save > 0 ? 'Save ₹' + plan.save : 'No discount';
        save.style.cssText = 'grid-area:save;font-size:11px;font-weight:600;color:#1e40af;';
        const perMonth = document.createElement('span');
        perMonth.textContent = '₹' + plan.perMonth + '/mo';
        perMonth.style.cssText = 'grid-area:per-month;font-size:11px;font-weight:600;color:#8e8e8e;justify-self:end;';
        btn.appendChild(duration);
        btn.appendChild(price);
        btn.appendChild(save);
        btn.appendChild(perMonth);
        btn.addEventListener('click', () => setPopupSelectedPlan(plan.key));
        picker.appendChild(btn);
    });
    updatePopupContinueButton();
}

// --- Manual-payment checkout (UPI), for the plan picked in the
// plan picker above ----------------------------------------------
// Shares the method picker, UPI view and proof form with the premium modal
// (premium-config.js) so the two never drift apart. Nothing here promises
// automatic activation for a manual payment: premium activates only once an
// admin approves the submitted proof.

function getPopupPaymentStep() {
    return document.getElementById('paymentStep');
}

function showPopupPaymentStep() {
    const step = getPopupPaymentStep();
    if (step) {
        step.style.display = 'block';
        step.innerHTML = '';
    }
    return step;
}

function hidePopupPaymentStep() {
    const step = getPopupPaymentStep();
    if (step) {
        step.style.display = 'none';
        step.innerHTML = '';
    }
}

function showPopupUnderReview() {
    const subscribeButton = document.getElementById('subscribeButton');
    if (subscribeButton) subscribeButton.style.display = 'none';
    const planPicker = document.getElementById('popupPlanPicker');
    if (planPicker) planPicker.style.display = 'none';
    const step = showPopupPaymentStep();
    if (step && typeof window.createUnderReviewNotice === 'function') {
        step.appendChild(window.createUnderReviewNotice());
    }
}

// When a proof is under review the popup shows that state instead of the
// Subscribe button. Called after login / login-status checks.
function refreshPopupPendingState(membership) {
    if (!membership || membership.turu === 'premium' || !membership.pendingProof) return;
    showPopupUnderReview();
}

async function showPopupPaymentFlow(plan) {
    plan = typeof window.getPremiumPlan === 'function'
        ? window.getPremiumPlan(plan).key : (plan || '1mo');
    const subscribeButton = document.getElementById('subscribeButton');
    const planPicker = document.getElementById('popupPlanPicker');
    const apiUrl = window.PAYMENT_API_URL;
    if (!apiUrl || typeof apiUrl !== 'string' || apiUrl.includes('PASTE-YOUR-WORKER')) {
        showErrorMessage('Payment is not configured yet.');
        return;
    }
    const data = await chrome.storage.local.get(['user_info']);
    const userId = (data.user_info && data.user_info.id) || '';
    const email = (data.user_info && data.user_info.email) || '';

    if (subscribeButton) subscribeButton.style.display = 'none';
    if (planPicker) planPicker.style.display = 'none';
    const step = showPopupPaymentStep();
    if (step) step.textContent = 'Loading payment methods…';
    const methods = typeof window.getPaymentMethods === 'function'
        ? await window.getPaymentMethods()
        : { upi: true, razorpay: false };

    const renderPicker = () => {
        const stepEl = showPopupPaymentStep();
        if (!stepEl || typeof window.createPaymentMethodPicker !== 'function') return;
        stepEl.appendChild(window.createPaymentMethodPicker({
            plan: plan,
            methods,
            onPick: (method) => onMethodPicked(method)
        }));
        const backBtn = document.createElement('button');
        backBtn.type = 'button';
        backBtn.textContent = 'Back';
        backBtn.style.cssText = 'margin-top:8px;padding:8px 14px;background:transparent;' +
            'border:1.5px solid #d4d4d4;border-radius:8px;color:#262626;font-size:13px;' +
            'font-weight:600;cursor:pointer;';
        backBtn.addEventListener('click', () => {
            hidePopupPaymentStep();
            if (planPicker) planPicker.style.display = 'block';
            if (subscribeButton) subscribeButton.style.display = 'block';
        });
        stepEl.appendChild(backBtn);
    };

    const showProofForm = (method) => {
        const stepEl = getPopupPaymentStep();
        if (!stepEl || typeof window.createProofForm !== 'function') return;
        stepEl.appendChild(window.createProofForm({
            plan: plan,
            method,
            userId,
            onSuccess: () => {
                // Proof accepted for review: keep Subscribe hidden so the
                // user cannot start a second checkout for the same plan.
                if (subscribeButton) subscribeButton.style.display = 'none';
            }
        }));
    };

    const onMethodPicked = async (method) => {
        if (method === 'upi') {
            const stepEl = showPopupPaymentStep();
            if (!stepEl) return;
            stepEl.appendChild(window.createUpiPaymentView(plan));
            showProofForm('upi');
            return;
        }
    };

    renderPicker();
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
            if (membership.pendingProof) {
                // A proof is already under review: show that state instead of
                // Subscribe, and do not start a poll for it.
                showPopupUnderReview();
                return;
            }
            await showPopupPaymentFlow(getPopupSelectedPlan());
        });
    }

    // Render the five-plan picker (default 1 month) in the Upgrade section.
    renderPopupPlanPicker();

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

        setPremiumBadge(badge, membership);

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
            const planPicker = document.getElementById('popupPlanPicker');
            if (planPicker) planPicker.style.display = 'none';
        } else {
            updatePopupContinueButton();
        }
    }

    // A proof under review replaces the Subscribe button with that state.
    refreshPopupPendingState(membership);

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

                setPremiumBadge(badge, membership);

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
                    const planPicker = document.getElementById('popupPlanPicker');
                    if (planPicker) planPicker.style.display = 'none';
                } else {
                    updatePopupContinueButton();
                }
            }

            // A proof under review replaces the Subscribe button with that state.
            // Re-read membership here: the background's copy may not carry
            // pendingProof, while the popup's own getPremiumMembership does.
            const freshMembership = await getPremiumMembership().catch(() => membership);
            refreshPopupPendingState(freshMembership);
            
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
  // Prices come from the shared plan definition (premium-config.js): the card
  // shows the cheapest plan as "From ₹X" and the biggest saving across plans.
  if (!Array.isArray(window.PREMIUM_PLANS) || !window.PREMIUM_PLANS.length) return;
  const cheapest = window.PREMIUM_PLANS[0];
  const newPriceEl = document.getElementById('newPrice');
  if (newPriceEl) newPriceEl.textContent = '₹' + cheapest.price;
  const biggestSave = Math.max.apply(null,
    window.PREMIUM_PLANS.map((plan) => plan.save || 0));
  const discountEl = document.getElementById('discountText');
  if (discountEl && biggestSave > 0) {
    discountEl.textContent = 'Save up to ₹' + biggestSave;
  }
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
     * The session bootstrap (ig-session.js) replaces /data/shared_data/, which Instagram removed
     * (it now answers 404). On a signed-in browser the viewer id comes from the browser's own
     * Instagram cookies, so the session check itself needs no request at all — and the id it
     * returns is proof of sign-in. Everything after it here is display detail (username,
     * follower/following counts), and a refusal there must never turn a signed-in user into
     * the "Instagram is limiting requests" screen: that screen is only for when no session
     * could be established at all.
     */
    const session = await window.IgSession.fetchSession();

    if (session.status === 'logged_out') {
      hideLoading();
      showInstagramLoginAlert();
      hideAnalyzeButton();
      return;
    }
    // No viewer id and not a clean sign-out: Instagram is refusing us outright — that really is
    // throttling, not a sign-in problem.
    if (session.status !== 'ok') {
      hideLoading();
      showInstagramLimitedAlert();
      return;
    }

    const viewerId = session.id;

    // Username: the session usually carries it (the cookie step's user-info call). Only when
    // it is missing do we ask web_form_data — and a refusal there is not a session problem,
    // so the popup stays logged in with the name blank instead of showing the limit screen.
    let username = session.username || '';
    let profilePic = session.profilePicUrl || '';
    if (!username) {
      try {
        const userResponse = await fetch('https://www.instagram.com/api/v1/accounts/edit/web_form_data/', {
          method: 'GET',
          credentials: 'include',
          headers: {
            'x-ig-app-id': '936619743392459',
            'x-requested-with': 'XMLHttpRequest'
          }
        });
        const userForm = await readIgJson(userResponse);
        if (!userForm.refused && !userForm.expired && userForm.data) {
          username = (userForm.data.form_data && userForm.data.form_data.username) || '';
        }
      } catch (e) {
        // Username stays blank; the session id is enough to proceed.
      }
    }

    // Counts are best-effort: a refusal leaves the dashes the HTML already shows.
    // They never decide the logged-in state.
    let followers = '-';
    let following = '-';
    try {
      const profileResponse = await fetch(`https://www.instagram.com/api/v1/users/${viewerId}/info/`, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'x-ig-app-id': '936619743392459',
          'x-requested-with': 'XMLHttpRequest'
        }
      });
      const profile = await readIgJson(profileResponse);
      const user = profile.data && profile.data.user;
      if (user) {
        followers = (user.follower_count ?? 0).toLocaleString();
        following = (user.following_count ?? 0).toLocaleString();
        if (!profilePic) profilePic = user.profile_pic_url || '';
        if (!username) username = user.username || '';
      }
    } catch (e) {
      // Counts stay dashes.
    }

    updateInstagramUI({
      isLoggedIn: true,
      username: username,
      followers: followers,
      following: following,
      profileImage: profilePic || 'img/48.png'
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


// v2: show the last analysis summary (followers / following / not-following / date)
// when the analyzer has stored one. Hidden cleanly when nothing exists yet.
function loadLastAnalysisSummary() {
  const card = document.getElementById('lastAnalysisCard');
  if (!card) return;
  chrome.storage.local.get(['lastAnalysisSummary'], (data) => {
    const summary = data.lastAnalysisSummary;
    if (!summary || typeof summary.nonFollowersCount !== 'number') {
      card.style.display = 'none';
      return;
    }
    document.getElementById('lastFollowers').textContent =
      Number(summary.followersCount).toLocaleString();
    document.getElementById('lastFollowing').textContent =
      Number(summary.followingCount).toLocaleString();
    document.getElementById('lastNonFollowers').textContent =
      Number(summary.nonFollowersCount).toLocaleString();
    const dateStr = new Date(summary.timestamp).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
    const dateEl = document.getElementById('lastAnalysisDate');
    const msg = getMessage('lastAnalysisDate', [dateStr]);
    dateEl.textContent = msg === 'lastAnalysisDate' ? `Scanned ${dateStr}` : msg;
    card.style.display = 'block';
  });
  const viewBtn = document.getElementById('viewResultsBtn');
  if (viewBtn && !viewBtn.dataset.wired) {
    viewBtn.dataset.wired = '1';
    viewBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('analyzer.html') });
      window.close();
    });
  }
}

function updateInstagramUI(data) {
  hideLoading(); // Hide loading
  
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
    loadLastAnalysisSummary();
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
