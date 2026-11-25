// i18n helper function
function getMessage(key, substitutions) {
    return chrome.i18n.getMessage(key, substitutions) || key;
}

// Initialize i18n for all elements with data-i18n attribute
function initializeI18n() {
    document.querySelectorAll('[data-i18n]').forEach(element => {
        const key = element.getAttribute('data-i18n');
        const message = getMessage(key);
        if (message && message !== key) {
            element.textContent = message;
        }
    });
    
    // Handle placeholder attributes (v2 search box)
    document.querySelectorAll('[data-i18n-placeholder]').forEach(element => {
        const message = getMessage(element.getAttribute('data-i18n-placeholder'));
        if (message && message !== element.getAttribute('data-i18n-placeholder')) {
            element.placeholder = message;
        }
    });

    // Handle title attributes
    document.querySelectorAll('[data-i18n-title]').forEach(element => {
        const key = element.getAttribute('data-i18n-title');
        const message = getMessage(key);
        if (message && message !== key) {
            element.title = message;
        }
    });
    
    // Update page title
    document.title = getMessage('pageTitle');
}

// DOM Elements
const elements = {
    followingList: document.getElementById('followingList'),
    userAvatar: document.getElementById('userAvatar'),
    userName: document.getElementById('userName'),
    followersCount: document.getElementById('followersCount'),
    followingCount: document.getElementById('followingCount'),
    nonFollowersCount: document.getElementById('nonFollowersCount'),
    loadingIndicator: document.getElementById('loadingIndicator'),
    loadingCount: document.getElementById('loadingCount')
};

const ANALYSIS_CACHE_VERSION = 3;

// Cache functions
async function getAnalysisCache(userId) {
    const data = await chrome.storage.local.get([`analysisCache_${userId}`]);
    const cache = data[`analysisCache_${userId}`] || null;
    // Version 3 invalidates all pre-3.0.5 caches that were poisoned by Web show_many omitting followed_by.
    if (!cache || cache.complete !== true) return null;
    if (!cache.version || cache.version < ANALYSIS_CACHE_VERSION) return null;
    if (!Array.isArray(cache.followingList) || !Array.isArray(cache.followersList)) return null;
    // Sanity guard: if account has followers and >=5 following, a 0-follower status cache is suspect.
    if (cache.followersTotal > 0 && cache.followingList.length >= 5 && cache.followersList.length === 0) {
        return null;
    }
    return cache;
}

async function saveAnalysisCache(userId, followingList, followersList, followersTotal) {
    // Slim data before saving to avoid quota issues (50K users = ~18MB vs ~70MB raw)
    const slimFollowing = followingList.map(u => {
        const node = {
            id: String(u.node.id),
            username: u.node.username,
            full_name: u.node.full_name || '',
            profile_pic_url: u.node.profile_pic_url,
            is_verified: u.node.is_verified || false
        };
        if (typeof u.node.follows_viewer === 'boolean') {
            node.follows_viewer = u.node.follows_viewer;
        }
        return { node };
    });
    const slimFollowers = followersList.map(u => ({
        node: {
            id: String(u.node.id),
            username: u.node.username || ''
        }
    }));
    await chrome.storage.local.set({
        [`analysisCache_${userId}`]: {
            version: ANALYSIS_CACHE_VERSION,
            followingList: slimFollowing,
            followersList: slimFollowers,
            followersTotal: followersTotal ?? null,
            timestamp: Date.now(),
            complete: true
        }
    });
}

async function removeUserFromCache(userId, username) {
    const cache = await getAnalysisCache(userId);
    if (!cache) return;
    cache.followingList = cache.followingList.filter(u => u.node.username !== username);
    await chrome.storage.local.set({ [`analysisCache_${userId}`]: cache });
}

// Whitelist functions
async function getWhitelist(userId) {
    const data = await chrome.storage.local.get([`whitelist_${userId}`]);
    return data[`whitelist_${userId}`] || [];
}

async function addToWhitelist(userId, username) {
    const list = await getWhitelist(userId);
    if (!list.includes(username)) {
        list.push(username);
        await chrome.storage.local.set({ [`whitelist_${userId}`]: list });
    }
}

async function removeFromWhitelist(userId, username) {
    let list = await getWhitelist(userId);
    list = list.filter(u => u !== username);
    await chrome.storage.local.set({ [`whitelist_${userId}`]: list });
}

// Analysis snapshot functions (for comparison)
async function getLastAnalysisSnapshot(userId) {
    const data = await chrome.storage.local.get([`analysisSnapshot_${userId}`]);
    return data[`analysisSnapshot_${userId}`] || null;
}

async function saveAnalysisSnapshot(userId, followersCount, followingCount, nonFollowersCount) {
    const prev = await getLastAnalysisSnapshot(userId);
    await chrome.storage.local.set({
        [`analysisSnapshot_${userId}`]: {
            followersCount,
            followingCount,
            nonFollowersCount,
            timestamp: Date.now(),
            previous: prev ? {
                followersCount: prev.followersCount,
                followingCount: prev.followingCount,
                nonFollowersCount: prev.nonFollowersCount,
                timestamp: prev.timestamp
            } : null
        },
        // v2: one small key the popup can read without knowing the Instagram user id,
        // so it can show a "Last analysis" summary. Only counts + date, no user list.
        lastAnalysisSummary: {
            userId,
            followersCount,
            followingCount,
            nonFollowersCount,
            timestamp: Date.now()
        }
    });
}

// Global değişkenler
let currentUserId = null;
let isUnfollowingActive = false;
let currentTimer = 120;
let timerInterval;
let followersCount = 0;
let followingCount = 0;
let nonFollowersCount = 0;
let lastProcessedIndex = 0;
let unfollowDelay = 60000;
let isProcessingQueue = false;
let retryTimeout = null;
let unfollowMode = 'nonFollowers';
let countdownTimer = null;
let currentCountdown = 0;
// counterTimeoutId now lives in premium.js, with the live-counter code that is its only user.
let unfollowEndTime = 0;   // Zaman damgası tabanlı bekleme için bitiş zamanı
let unfollowTimerId = null; // setTimeout ID'si (temizleme için)

// Pagination state
const PAGE_SIZE = 100;
let currentPage = 1;
let totalPages = 1;
let allDisplayData = [];       // full display list (user objects)
let allFollowersList = [];     // full followers list for comparison
/**
 * Every account this user follows, before the free-plan display cap is applied.
 *
 * allDisplayData is a slice for free users, so it cannot be used to answer "do I follow this
 * person?" — and the write-path probe depends on that answer being right. Getting it wrong there
 * means unfollowing somebody during what is supposed to be a no-op health check.
 */
let allFollowingFull = [];
let currentWhitelistSet = new Set();
let showOnlyNonFollowersFilter = false;
// v2 toolbar state (client-side only, over already-loaded data)
let analyzerSearchQuery = '';
let analyzerSortMode = 'default';
let analyzerChipFilter = 'all';

// Sekme geri geldiğinde timer'ı hemen güncelle (Chrome throttling fix)
document.addEventListener('visibilitychange', () => {
    if (!document.hidden && isUnfollowingActive && unfollowEndTime > 0) {
        const remaining = Math.max(0, Math.ceil((unfollowEndTime - Date.now()) / 1000));
        updateTimerDisplay(remaining);
    }
});

// Capture image load errors without violating CSP with inline onerror handlers
document.addEventListener('error', function (e) {
    if (e.target && e.target.tagName === 'IMG' && (e.target.classList.contains('profile-image') || e.target.id === 'userAvatar')) {
        e.target.src = 'img/48.png';
    }
}, true);

// DOM yüklendiğinde elements'i kontrol et
document.addEventListener('DOMContentLoaded', () => {
    // Initialize i18n
    initializeI18n();
    
    // Elements'in tüm değerlerini kontrol et
    for (const [key, value] of Object.entries(elements)) {
        if (!value) {
            console.error(`Element not found: ${key}`);
        }
    }

    // Unfollow butonları için event listener'ları ekle
    setupUnfollowListeners();

    // Premium upgrade buttons
    const upgradeBtn = document.getElementById('upgradeToPremiumBtn');
    if (upgradeBtn) {
        upgradeBtn.addEventListener('click', function() {
            openPremiumModal();
        });
    }
    const headerUpgradeBtn = document.getElementById('headerUpgradeBtn');
    if (headerUpgradeBtn) {
        headerUpgradeBtn.addEventListener('click', function() {
            openPremiumModal();
        });
    }
    
    // Premium modal close button
    const premiumModalClose = document.querySelector('.premium-modal-close');
    if (premiumModalClose) {
        premiumModalClose.addEventListener('click', closePremiumModal);
    }
    
    // Premium modal overlay click to close
    const premiumModal = document.getElementById('premiumModal');
    if (premiumModal) {
        const premiumModalOverlay = premiumModal.querySelector('.premium-modal-overlay');
        if (premiumModalOverlay) {
            premiumModalOverlay.addEventListener('click', closePremiumModal);
        }
    }
    
    // Add click handlers for card subscribe buttons
    document.addEventListener('click', function(e) {
        if (e.target.classList.contains('premium-card-subscribe-button')) {
            const planType = e.target.getAttribute('data-plan') || '1mo';
            handlePremiumSubscribe(planType);
        }
    });
    
    // Initialize premium modal pricing
    initializePremiumModal();
    
    // ESC key to close modal
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            const premiumModal = document.getElementById('premiumModal');
            if (premiumModal && premiumModal.classList.contains('active')) {
                closePremiumModal();
            }
        }
    });

    // İstatistikler initializeFollowingList'te güncelleniyor
    
    // Unfollow butonları için event listener'ları ekle
    const nonFollowersBtn = document.getElementById('unfollowNonFollowers');
    const everyoneBtn = document.getElementById('unfollowEveryone');
    const stopBtn = document.getElementById('stopUnfollow');
    
    if (nonFollowersBtn) {
        nonFollowersBtn.addEventListener('click', startUnfollowNonFollowers);
    }
    if (everyoneBtn) {
        everyoneBtn.addEventListener('click', startUnfollowEveryone);
    }
    if (stopBtn) {
        stopBtn.addEventListener('click', stopUnfollowProcess);
    }

    // Re-analyze button
    const reAnalyzeBtn = document.getElementById('reAnalyzeBtn');
    if (reAnalyzeBtn) {
        reAnalyzeBtn.addEventListener('click', () => {
            reAnalyzeBtn.disabled = true;
            reAnalyzeBtn.querySelector('.btn-reanalyze-text').textContent = getMessage('reAnalyzing');
            initializeFollowingList(true);
        });
    }
});

// Instagram API error helper
function handleInstagramApiError(response) {
    if (response.status === 429) {
        const err = new Error(getMessage('errorRateLimit'));
        err.code = 'RATE_LIMIT';
        throw err;
    }
    if (response.status === 401 || response.status === 403) {
        const err = new Error(getMessage('errorSessionExpired'));
        err.code = 'SESSION_EXPIRED';
        throw err;
    }
    if (response.status >= 500) {
        const err = new Error(getMessage('errorInstagramUnavailable'));
        err.code = 'SERVER_ERROR';
        throw err;
    }
    if (!response.ok) {
        const err = new Error(getMessage('errorFetchingData'));
        err.code = 'UNKNOWN';
        throw err;
    }
}

// Instagram API Functions
async function getCurrentUserId() {
    try {
        // Session bootstrap (ig-session.js): Instagram removed /data/shared_data/ (404), so the
        // viewer id now comes off the Instagram homepage, confirmed with web_form_data.
        const session = await window.IgSession.fetchSession();
        if (session.status === 'logged_out' || !session.id) {
            logScanDiag({
                stage: 'session',
                msg: 'NO Instagram session in this Chrome browser',
                detail: 'Open instagram.com in this Chrome browser and log in first' + (session.detail ? ' — ' + session.detail : '')
            });
            return null;
        }
        if (session.status !== 'ok') {
            const version = (chrome.runtime && chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '';
            const detail = (session.detail ? ' — ' + session.detail : '') + (version ? ' [v' + version + ']' : '');
            logScanDiag({ stage: 'session', msg: 'Session refused (' + (session.reason || 'unknown') + ')', detail: session.detail || '' });
            const err = new Error(getMessage(session.reason === 'rate_limit' ? 'errorRateLimit' : 'errorInstagramUnavailable') + detail);
            err.code = session.reason === 'rate_limit' ? 'RATE_LIMIT' : 'SERVER_ERROR';
            throw err;
        }
        sessionUsername = session.username || ('user_' + String(session.id).slice(-4));
        logScanDiag({
            stage: 'session',
            msg: 'Instagram session found',
            detail: '@' + sessionUsername + ' (id ' + session.id + ') — the scan reads this account'
        });
        return session.id;
    } catch (error) {
        console.error('Error getting user ID:', error);
        if (error.code) throw error; // re-throw API errors with user-friendly messages
        return null;
    }
}

/**
 * How the last read of each list went. Consulted before the two lists are diffed and before any
 * bulk action: a short followers list turns real followers into "doesn't follow back", and this
 * extension acts on that difference.
 */
const lastScanInfo = { followers: null, following: null };
let cachedViewer = null;

// --- Scan diagnostics (shown on the page so a failed scan can be reported accurately) ---
let sessionUsername = '';
const scanDiagLog = [];
function logScanDiag(entry) {
    scanDiagLog.push({ t: new Date().toISOString(), ...entry });
    if (scanDiagLog.length > 60) scanDiagLog.shift();
    try { chrome.storage.local.set({ scanDiagnostics: scanDiagLog }); } catch (error) {}
}
function renderScanDiag() {
    const pre = document.getElementById('scanDiagnosticsPre');
    if (!pre) return;
    const box = document.getElementById('scanDiagnosticsBox');
    if (box) box.style.display = scanDiagLog.length ? 'block' : 'none';
    pre.textContent = scanDiagLog.map((e) =>
        `[${e.t}] ${e.stage || ''}${e.path ? ' (' + e.path + ')' : ''}: ${e.msg}${e.detail ? ' — ' + e.detail : ''}`
    ).join('\n');
}

function isDataComplete() {
    return !!(lastScanInfo.followers?.complete && lastScanInfo.following?.complete);
}

async function getViewerOnce() {
    if (!cachedViewer) cachedViewer = await window.UnfollowBridge.getViewer();
    return cachedViewer;
}

/**
 * The follower/following totals Instagram itself shows, fetched once per analysis.
 *
 * Two jobs: it turns the spinner into a real progress bar, and it is an independent check that a
 * scan which claims to be complete actually brought back everything.
 */
let cachedExpected = null;
async function getExpectedOnce(userId, type) {
    if (!cachedExpected) {
        cachedExpected = (await window.UnfollowBridge.getExpectedCounts(userId)) || {};
    }
    return type === 'following' ? cachedExpected.following : cachedExpected.followers;
}

/** Circumference of the progress ring: 2 * pi * 52, matching the r in analyzer.html. */
const SCAN_RING_LENGTH = 326.7;

/**
 * Works out what to tell the user about a scan that did not finish.
 *
 * The three outcomes need different words, because they need different actions. Refused outright
 * means come back later; cut off half way means run it again in a minute; short of the expected
 * total means the same but for a reason the user cannot see. Collapsing them into one generic
 * error is how people end up retrying immediately, which is the one thing that makes it worse.
 *
 * @returns {{title: string, body: string, retry: boolean}}
 */
function describeScanFailure() {
    const worst = [lastScanInfo.followers, lastScanInfo.following]
        .filter((info) => info && !info.complete)[0] || {};
    const which = worst === lastScanInfo.following
        ? (getMessage('scanBlockedListFollowing') || 'The following list could not be read right now.')
        : (getMessage('scanBlockedListFollowers') || 'The followers list could not be read right now.');

    // Nothing came back at all, on either endpoint.
    if (worst.reason === 'blocked') {
        return {
            title: getMessage('scanBlockedTitle') || 'Instagram wants a short break',
            body: which + ' ' + (getMessage('scanBlockedBody')
                || 'This is common, it clears up on its own, and there is nothing wrong with your '
                 + 'account or the extension. We stopped straight away rather than retrying, '
                 + 'because repeated attempts make the wait longer. Try again later today.'),
            retry: false
        };
    }

    // Some of the list arrived and then Instagram stopped answering.
    if (worst.reason === 'rate_limited') {
        return {
            title: getMessage('scanPartialTitle') || 'The list came back incomplete',
            body: which + ' ' + (getMessage('scanPartialBody')
                || 'Part of it arrived and then Instagram paused us, so the results are not '
                 + 'complete enough to act on. Nothing has been changed. Come back later — this can '
                 + 'take hours to lift, and retrying now extends it.'),
            retry: true
        };
    }

    // It ended tidily but well below the total Instagram itself reports.
    if (worst.reason === 'short_of_expected') {
        return {
            title: getMessage('scanShortTitle') || 'Some accounts are missing',
            body: getMessage('scanShortBody')
                || 'The scan finished, but fewer accounts came back than Instagram says the list '
                 + 'holds. Acting on it could unfollow people who do follow you back, so nothing '
                 + 'is shown. Please run the analysis again.',
            retry: true
        };
    }

    return {
        title: getMessage('incompleteDataTitle') || 'The list is incomplete',
        body: getMessage('incompleteDataMessage')
            || 'The list did not arrive in full, so nothing is shown. Please run the analysis again.',
        retry: true
    };
}

/**
 * Puts a notice where the table would go.
 *
 * Deliberately in place of the rows rather than beside them: a warning next to a list of accounts
 * with Unfollow buttons is a warning most people will click past.
 */
function showScanNotice({ title, body, retry }) {
    const tbody = document.getElementById('followingList');
    if (!tbody) return;
    const retryLabel = getMessage('reAnalyze') || 'Re-analyze';
    tbody.innerHTML = `
        <tr><td colspan="7">
            <div class="scan-notice">
                <div class="scan-notice-icon">
                    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="12" r="10"></circle>
                        <line x1="12" y1="7" x2="12" y2="13"></line>
                        <line x1="12" y1="17" x2="12.01" y2="17"></line>
                    </svg>
                </div>
                <div class="scan-notice-text">
                    <b>${title}</b>
                    <p>${body}</p>
                    ${retry ? `<button class="scan-notice-btn" id="scanNoticeRetry">${retryLabel}</button>` : ''}
                    <p class="scan-notice-hint">Session in this browser: <b>${sessionUsername ? '@' + sessionUsername : 'not logged in'}</b> —
                        the scan reads Instagram through that logged-in session. Open the
                        <b>Scan details</b> box below the table for the exact step that failed.</p>
                </div>
            </div>
        </td></tr>`;

    const btn = document.getElementById('scanNoticeRetry');
    if (btn) btn.addEventListener('click', () => initializeFollowingList(true), { once: true });
    renderScanDiag();
}

/**
 * Marks which of the two lists is being read.
 *
 * They are read one after the other, so without this the counter appears to reset to zero half
 * way through and the whole thing looks like it started over.
 */
/**
 * Put the panel into a moving "working, nothing to measure yet" state.
 *
 * Used before the first page arrives and on a cache hit, where there is no progress to report at
 * all. Both used to show a motionless ring reading "--" under "Starting analysis…", which is what a
 * hung page looks like — and on a cache hit that was the entire experience.
 */
function beginIndeterminate(detailText) {
    const ring = document.querySelector('#loadingIndicator .scan-ring');
    if (ring) ring.classList.add('indeterminate');

    const ringText = document.getElementById('scanRingText');
    if (ringText) ringText.textContent = '';
    const big = document.getElementById('scanBigCount');
    if (big) big.textContent = '';
    const progress = document.getElementById('loadingProgress');
    if (progress) progress.style.display = 'none';

    if (detailText !== undefined) {
        const detail = document.getElementById('loadingDetail');
        if (detail) detail.textContent = detailText;
    }
}

/**
 * The cache path: the lists are already here, so there are no follower/following stages to walk
 * through. Showing them idle implies work that is not happening.
 */
function showCacheLoadingState() {
    const title = document.getElementById('loadingCount');
    if (title) title.textContent = getMessage('loadingSavedAnalysis') || 'Loading saved analysis…';
    beginIndeterminate(getMessage('loadingSavedAnalysisDetail') || '');
    ['scanStepFollowers', 'scanStepFollowing'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.classList.remove('active', 'done');
    });
    const steps = document.querySelector('#loadingIndicator .scan-steps');
    if (steps) steps.style.display = 'none';
}

/**
 * @param {'followers'|'following'} type
 * @param {boolean} [singleStage] True when the run reads one list rather than two.
 *
 * The step row exists to say "there are two of these and you are on the first". A one-list read
 * has nothing to say with it: leaving both steps up promises a followers pass that never comes,
 * and hiding one leaves a lone step beside a connector line drawn to nowhere. So the row goes
 * altogether, and the donut, count and bar — which already say everything — carry the panel.
 */
function setScanStage(type, singleStage) {
    const steps = document.querySelector('#loadingIndicator .scan-steps');
    // A real two-list scan walks the stages, so the row comes back for it.
    if (steps) steps.style.display = singleStage ? 'none' : '';

    const stages = { followers: 'scanStepFollowers', following: 'scanStepFollowing' };
    const order = ['followers', 'following'];
    const current = order.indexOf(type);

    order.forEach((name, index) => {
        const el = document.getElementById(stages[name]);
        if (!el) return;
        el.classList.toggle('active', index === current);
        el.classList.toggle('done', index < current);
    });

    const title = document.getElementById('loadingCount');
    if (title) {
        title.textContent = type === 'following'
            ? (getMessage('statFollowing') || 'Following')
            : (getMessage('statFollowers') || 'Followers');
    }
    const big = document.getElementById('scanBigCount');
    if (big) big.textContent = '0';
}

/**
 * How long to wait after Instagram refuses a write, each time it happens in one run.
 *
 * Measured on a throttled account: a refusal does not clear in a few seconds. Escalating rather
 * than retrying on a fixed timer means a run that meets a limit slows down and finishes, instead
 * of hammering the same closed door until it gives up.
 */
const WRITE_BACKOFF_MS = [30000, 60000, 120000, 300000];
let writeBackoffStep = 0;

/** Ticker for the pause countdown, so only one is ever running. */
let rateLimitTimer = null;
let writeCountdownTimer = null;

/**
 * Count down a pause in the unfollow run, on the countdown chip in the toolbar.
 *
 * A silent five-minute wait is indistinguishable from a crash, and the user's instinct is to
 * reload — which loses the queue and starts the whole thing again.
 */
function showWriteBackoffCountdown(seconds) {
    if (writeCountdownTimer) clearInterval(writeCountdownTimer);
    const display = document.getElementById('countdownDisplay');
    const text = document.getElementById('countdownText');
    if (display) display.style.display = 'flex';

    let left = Math.max(1, seconds);
    const draw = () => {
        if (text) {
            text.textContent = getMessage('rateLimitWaiting', [String(left)])
                || `Paused — resuming in ${left}s`;
        }
    };
    draw();
    writeCountdownTimer = setInterval(() => {
        left -= 1;
        if (left <= 0) {
            clearInterval(writeCountdownTimer);
            writeCountdownTimer = null;
            return;
        }
        draw();
    }, 1000);
}

/**
 * Count a pause down out loud.
 *
 * Instagram's backoffs are 30, 60 and 120 seconds. A panel that just stops for two minutes is
 * read as a crash, and the user reloads — which is the one thing that makes the wait longer.
 */
function startRateLimitCountdown(seconds) {
    stopRateLimitCountdown();
    const detail = document.getElementById('loadingDetail');
    const ring = document.querySelector('.scan-ring');
    const eta = document.getElementById('loadingEta');
    if (ring) ring.classList.add('waiting');
    if (eta) eta.textContent = '';

    let left = Math.max(1, seconds);
    const draw = () => {
        if (detail) {
            detail.textContent = getMessage('rateLimitWaiting', [String(left)])
                || `Instagram asked us to pause — resuming in ${left}s`;
        }
    };
    draw();
    rateLimitTimer = setInterval(() => {
        left -= 1;
        if (left <= 0) { stopRateLimitCountdown(); return; }
        draw();
    }, 1000);
}

function stopRateLimitCountdown() {
    if (rateLimitTimer) { clearInterval(rateLimitTimer); rateLimitTimer = null; }
    const ring = document.querySelector('.scan-ring');
    if (ring) ring.classList.remove('waiting');
}

/**
 * Draws the scan panel.
 *
 * v1 hands back about 23 accounts per request, so a 10,000-follower list is several hundred round
 * trips over several minutes. A bare spinner over that period reads as a hang, which is the main
 * reason a scan that was working fine gets abandoned half way.
 */
function renderScanProgress(type, progress, expected) {
    const { count = 0, elapsedMs = 0, rateLimitedForMs } = progress || {};
    const detail = document.getElementById('loadingDetail');
    const big = document.getElementById('scanBigCount');
    const ring = document.querySelector('.scan-ring');
    const arc = document.getElementById('scanRingArc');
    const ringText = document.getElementById('scanRingText');
    const panel = document.getElementById('loadingProgress');
    const bar = document.getElementById('loadingBar');
    const pct = document.getElementById('loadingPercent');
    const eta = document.getElementById('loadingEta');

    if (rateLimitedForMs) {
        // A pause of thirty seconds or more with a static panel is indistinguishable from a crash,
        // so the wait counts itself down out loud and the ring switches to a waiting state.
        startRateLimitCountdown(Math.round(rateLimitedForMs / 1000));
        return;
    }
    stopRateLimitCountdown();

    if (big) big.textContent = count.toLocaleString();

    if (!expected) {
        // No total to measure against, so the ring sweeps rather than pretending to know.
        if (ring) ring.classList.add('indeterminate');
        if (ringText) ringText.textContent = '';
        if (detail) detail.textContent = getMessage('dataLoadingFollowers', [count.toLocaleString()]) || '';
        return;
    }

    if (ring) ring.classList.remove('indeterminate');
    const percent = Math.min(99, Math.round((count / expected) * 100));
    if (arc) arc.style.strokeDashoffset = String(SCAN_RING_LENGTH * (1 - percent / 100));
    if (ringText) ringText.textContent = '%' + percent;
    if (big) big.textContent = `${count.toLocaleString()} / ${expected.toLocaleString()}`;

    if (panel) panel.style.display = 'block';
    if (bar) bar.style.width = percent + '%';
    // Deliberately not the same figure as the headline above it: that already reads
    // "3,240 / 10,000", so repeating it here would waste the line.
    const remaining = Math.max(0, expected - count);
    // Not `accountsRemaining` — that key already exists and means something else entirely
    // (the free-plan daily cap notice), so reusing it would print the wrong sentence here.
    if (pct) pct.textContent = getMessage('scanRemaining', [remaining.toLocaleString()])
        || `${remaining.toLocaleString()} left`;

    // Estimated from the rate actually achieved so far, not from an assumed cost per request.
    //
    // Held back until there is enough of a sample to mean anything: the first page arrives almost
    // instantly, so estimating from it produced "~0 sn kaldı" with nine hundred accounts still to
    // go — a number so obviously wrong it undermines the rest of the panel.
    if (eta && count >= 40 && elapsedMs > 4000) {
        const secondsLeft = Math.round((elapsedMs / count) * Math.max(0, expected - count) / 1000);
        if (secondsLeft >= 5) {
            // Was written in Turkish directly here, which every other locale then read as well.
            eta.textContent = secondsLeft > 90
                ? (getMessage('etaMinutes', [String(Math.ceil(secondsLeft / 60))])
                    || `~${Math.ceil(secondsLeft / 60)} min left`)
                : (getMessage('etaSeconds', [String(secondsLeft)]) || `~${secondsLeft} sec left`);
        }
    }
}

/**
 * Whether the last analysis answered the follow-back question from the following list alone.
 *
 * Kept because two things downstream have to know: the follower total can no longer be counted
 * from `followersList` (it holds only the followers who are also followed back), and the
 * "unfollowed you" comparison is narrower than it used to be.
 */
let usedFollowsViewer = false;
let realFollowersTotal = null;

/**
 * The short path: read `following` once, with each record's follow-back status attached.
 *
 * The old path reads both lists and diffs them by id. On the account this was reported from —
 * 17,179 followers, 17 following — that is roughly 390 requests, and v1 gives up around 11,000,
 * at which point the reserve endpoint starts again from the first page because a v1 cursor means
 * nothing to it. Nine minutes of a frozen counter, for an answer Instagram was already supplying.
 *
 * `follows_viewer` is that answer. One list, and on that account one request.
 *
 * Returns null when the query cannot be used, and the caller then does exactly what it did before.
 */
async function readFollowingWithStatus(userId) {
    const { scanFollowingWithStatus } = window.UnfollowBridge;
    if (!scanFollowingWithStatus) return null;

    const expected = await getExpectedOnce(userId, 'following');
    setScanStage('following', true);
    const reportCount = (progress) => renderScanProgress('following', progress, expected);

    // Same preference as the two-list read: run it inside an open Instagram tab when there is one,
    // so the requests leave from instagram.com rather than from this extension page. This is the
    // read every analysis performs, so it is the one most worth routing that way.
    let result = null;
    const pageBridge = window.UnfollowPageBridge;
    if (pageBridge && await pageBridge.isPageAvailable()) {
        const attempt = await pageBridge.runScanInPage({
            userId, listType: 'following', mode: 'follows_viewer', onProgress: reportCount
        });
        // `usedStatusReader` is the guard against a page script older than this file: it would
        // have run the two-list reader instead, and its records carry no follow-back status at
        // all — every account would then look like a non-follower.
        if (attempt.delivered && attempt.result?.usedStatusReader) {
            result = attempt.result;
            logScanDiag({ stage: 'following', path: 'instagram-tab', msg: 'bridge follows_viewer ok',
                detail: result.users.length + ' users in ' + result.requests + ' requests' });
        } else {
            logScanDiag({ stage: 'following', path: 'instagram-tab', msg: 'bridge unavailable',
                detail: attempt.error || 'old page script or refused' });
        }
    }

    if (!result) {
        result = await scanFollowingWithStatus({ userId, expected, onProgress: reportCount });
        logScanDiag({ stage: 'following', path: 'extension-page', msg: 'direct follows_viewer read',
            detail: `reason=${result.reason} users=${result.users.length} expected=${expected ?? '-'} complete=${result.complete} requests=${result.requests}` });
    }

    const panel = document.getElementById('loadingProgress');
    if (panel) panel.style.display = 'none';

    // Anything short of a clean, complete read hands back to the old path rather than guessing.
    // A partial following list would mark everyone it never reached as a non-follower, and the
    // bulk unfollow button acts on that list.
    if (!result.complete) {
        logScanDiag({ stage: 'following', msg: 'falls back to two-list read', detail: 'reason=' + result.reason });
        return null;
    }
    if (expected && result.users.length < expected * 0.9) {
        console.warn(`[bridge] follows_viewer: ${result.users.length}/${expected} geldi, eski yola dusuluyor`);
        return null;
    }

    // Verify every single user actually carries boolean follows_viewer
    const allHaveBooleanStatus = result.users.every(u => u && u.node && typeof u.node.follows_viewer === 'boolean');
    if (!allHaveBooleanStatus) {
        logScanDiag({ stage: 'following', msg: 'missing boolean follows_viewer, falling back to two-list scan' });
        return null;
    }

    // Spot-verify fast-path honesty against a 1-page follower sample + single-account friendship check
    const expectedFollowers = await getExpectedOnce(userId, 'followers');
    const honest = await verifyStatusScanHonesty(userId, result.users, expectedFollowers);
    if (!honest) {
        logScanDiag({ stage: 'following', msg: 'follows_viewer failed spot-check, falling back to two-list scan' });
        return null;
    }

    console.log('[bridge] follows_viewer:', {
        count: result.users.length, requests: result.requests, reason: result.reason
    });
    return result;
}

/**
 * Cross-checks a `follows_viewer` scan against real follower sample & `friendships/show/{id}/`
 * so a stale or altered GraphQL field can NEVER misclassify mutual followers as non-followers.
 */
async function verifyStatusScanHonesty(userId, followingUsers, expectedFollowers) {
    if (!Array.isArray(followingUsers) || followingUsers.length === 0) return true;
    try {
        const viewer = await getViewerOnce().catch(() => null);
        const { readFollowersSample, checkFriendshipStatus } = window.UnfollowBridge;

        // 1. Compare against one real page of followers (1 request)
        if (typeof readFollowersSample === 'function') {
            const sample = await readFollowersSample({ userId, csrfToken: viewer?.csrfToken });
            if (Array.isArray(sample) && sample.length > 0) {
                const sampleIds = new Set(sample.map(s => s?.node?.id != null ? String(s.node.id) : '').filter(Boolean));
                const sampleNames = new Set(sample.map(s => s?.node?.username ? s.node.username.toLowerCase() : '').filter(Boolean));
                for (const u of followingUsers) {
                    const uid = u?.node?.id != null ? String(u.node.id) : '';
                    const uname = u?.node?.username ? u.node.username.toLowerCase() : '';
                    if ((uid && sampleIds.has(uid)) || (uname && sampleNames.has(uname))) {
                        if (u.node.follows_viewer !== true) {
                            console.warn('[verify] Follower in sample had follows_viewer=false:', u.node.username);
                            return false;
                        }
                    }
                }
            }
        }

        // 2. Spot-check up to 2 accounts marked as non-followers via authoritative friendships/show/{id}/
        if (typeof checkFriendshipStatus === 'function') {
            const markedNonFollowers = followingUsers.filter(u => u?.node?.follows_viewer === false && u?.node?.id);
            const probes = markedNonFollowers.slice(0, 2);
            let verifiedCount = 0;
            for (const u of probes) {
                const rel = await checkFriendshipStatus(u.node.id, viewer?.csrfToken);
                if (rel && rel.ok) {
                    verifiedCount++;
                    if (rel.followedBy === true) {
                        console.warn('[verify] Account marked non-follower actually follows back:', u.node.username);
                        return false;
                    }
                }
            }
            // If 0 mutuals were found despite account having followers, require at least 1 confirmed check
            const mutualCount = followingUsers.filter(u => u?.node?.follows_viewer === true).length;
            if (expectedFollowers > 0 && followingUsers.length >= 5 && mutualCount === 0 && verifiedCount === 0) {
                return false;
            }
        }
        return true;
    } catch (e) {
        console.warn('[verify] Honesty check error, preferring two-list scan:', e);
        return false;
    }
}

async function getFollowingList(userId, opts) {
    return readList(userId, 'following', opts);
}

async function getFollowersList(userId, opts) {
    return readList(userId, 'followers', opts);
}

/**
 * Read one list through the bridge (v1 first, legacy graphql in reserve) and record how it ended.
 * Returns the same edge array shape the rest of this file has always consumed.
 */
async function readList(userId, type, opts = {}) {
    const { scanPeers, SCAN_REASON } = window.UnfollowBridge;
    const viewer = await getViewerOnce();
    const preferGraphql = !!opts.preferGraphql;

    const expected = await getExpectedOnce(userId, type);

    setScanStage(type);
    const reportCount = (progress) => renderScanProgress(type, progress, expected);

    let result = null;
    const pageBridge = window.UnfollowPageBridge;
    if (pageBridge && await pageBridge.isPageAvailable()) {
        const attempt = await pageBridge.runScanInPage({
            userId,
            listType: type,
            mode: preferGraphql ? 'graphql_first' : undefined,
            onProgress: reportCount
        });
        if (attempt.delivered && attempt.result) {
            result = attempt.result;
            logScanDiag({ stage: type, path: 'instagram-tab', msg: 'bridge read ok',
                detail: `source=${result.source} users=${result.users.length} reason=${result.reason}` });
        } else {
            logScanDiag({ stage: type, path: 'instagram-tab', msg: 'bridge unavailable',
                detail: attempt.error || 'refused' });
        }
    }

    if (!result) {
        result = await scanPeers({
            userId,
            type,
            expected,
            csrfToken: viewer?.csrfToken,
            preferGraphql,
            onProgress: reportCount
        });
        logScanDiag({ stage: type, path: 'extension-page', msg: 'direct read',
            detail: `source=${result.source} users=${result.users.length} expected=${expected ?? '-'} reason=${result.reason} complete=${result.complete} requests=${result.requests}` });
    }

    const panel = document.getElementById('loadingProgress');
    if (panel) panel.style.display = 'none';

    // Independent check on the scan's own verdict. A read can end tidily — cursor exhausted, no
    // refusal — and still be far short of the list Instagram says exists. Trusting `complete`
    // alone would let that through to the diff, and the diff is what bulk unfollow acts on.
    // The tolerance is deliberately loose: the count moves while the scan runs, and Instagram's
    // own figure lags. Only a gross shortfall is treated as truncation.
    if (result.complete && expected && result.users.length < expected * 0.9) {
        console.warn(`[bridge] ${type}: ${result.users.length}/${expected} geldi, eksik sayiliyor`);
        result = { ...result, complete: false, reason: 'short_of_expected' };
    }

    lastScanInfo[type] = {
        complete: result.complete,
        reason: result.reason,
        count: result.users.length,
        source: result.source,
        usedFallback: result.usedFallback,
        requests: result.requests
    };
    console.log(`[bridge] ${type}:`, lastScanInfo[type]);

    // A dead session is the one case worth interrupting for: nothing else in the flow can proceed,
    // and the fix is on the user's side. Everything else is reported by the panel below the scan,
    // which can say precisely what happened rather than collapsing to one generic error.
    if (result.reason === SCAN_REASON.FAILED && result.users.length === 0) {
        const err = new Error(getMessage('errorSessionExpired'));
        err.code = 'SESSION_EXPIRED';
        throw err;
    }

    return result.users;
}

function isUserFollowingMe(user, followersList) {
    if (!user || !user.node) return false;
    if (user.node.follows_viewer === true) return true;
    if (!followersList || !followersList.length) return false;
    const uid = user.node.id != null ? String(user.node.id) : null;
    const uname = user.node.username ? user.node.username.toLowerCase() : null;
    return followersList.some(f => {
        if (!f || !f.node) return false;
        if (uid && f.node.id != null && String(f.node.id) === uid) return true;
        if (uname && f.node.username && f.node.username.toLowerCase() === uname) return true;
        return false;
    });
}

function findNonFollowers(following, followers) {
    if (!following || !following.length) return [];
    const followerIds = new Set((followers || []).map(f => f?.node?.id != null ? String(f.node.id) : null).filter(Boolean));
    const followerUsernames = new Set((followers || []).map(f => f?.node?.username ? f.node.username.toLowerCase() : null).filter(Boolean));
    return following.filter(user => {
        if (user?.node?.follows_viewer === true) return false;
        const uid = user?.node?.id != null ? String(user.node.id) : null;
        if (uid && followerIds.has(uid)) return false;
        const uname = user?.node?.username ? user.node.username.toLowerCase() : null;
        if (uname && followerUsernames.has(uname)) return false;
        return true;
    });
}

function escapeHtmlSafe(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
}

function createTableRow(user, index, followers, whitelistSet) {
    const isFollowing = isUserFollowingMe(user, followers);
    const isUnfollowed = !!user._unfollowed;
    const rowClass = (isFollowing ? 'following-user' : 'not-following-user') + (isUnfollowed ? ' unfollowed-row' : '');
    const isWhitelisted = whitelistSet && whitelistSet.has(user.node.username);

    const originalProfileUrl = user.node.profile_pic_url || 'img/48.png';

    const followingBadgeText = isFollowing ? getMessage('followingYouBadge') : getMessage('notFollowingYouBadge');
    const unfollowText = isUnfollowed
        ? `<span class="success-icon">✓</span> ${getMessage('unfollowedSuccess')}`
        : getMessage('unfollow');
    const whitelistTitle = isWhitelisted ? getMessage('removeFromWhitelist') : getMessage('addToWhitelist');
    const safeUsername = escapeHtmlSafe(user.node.username);
    const safeFullName = escapeHtmlSafe(user.node.full_name || '');
    const btnClasses = [
        'unfollow-btn',
        isFollowing ? 'mutual-unfollow-btn' : '',
        isUnfollowed ? 'unfollowed' : ''
    ].filter(Boolean).join(' ');
    const btnDisabled = (isUnfollowed || isWhitelisted) ? ' disabled' : '';

    return `
        <tr class="${rowClass}${isWhitelisted ? ' whitelisted-row' : ''}" data-username="${safeUsername}" data-fullname="${safeFullName}">
            <td class="row-number">${index + 1}</td>
            <td>
                <div class="profile-cell">
                    <img src="${originalProfileUrl}" data-orig="${originalProfileUrl}" referrerpolicy="no-referrer" alt="Profile" class="profile-image">
                </div>
            </td>
            <td>
                <a href="https://instagram.com/${encodeURIComponent(user.node.username)}" target="_blank" rel="noopener noreferrer" class="username-cell">@${safeUsername}</a>
            </td>
            <td class="fullname-cell">${safeFullName || '<span class="text-muted">—</span>'}</td>
            <td>${user.node.is_verified ? '<span class="verified-badge" title="Verified"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg></span>' : '<span class="text-muted">—</span>'}</td>
            <td>
                <span class="${isFollowing ? 'following-badge' : 'not-following-badge'}">
                    ${followingBadgeText}
                </span>
            </td>
            <td class="action-cell">
                <button type="button" class="whitelist-btn${isWhitelisted ? ' active' : ''}" data-username="${safeUsername}" title="${escapeHtmlSafe(whitelistTitle)}" aria-label="${escapeHtmlSafe(whitelistTitle)}">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="${isWhitelisted ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>
                </button>
                <button type="button" class="${btnClasses}" data-username="${safeUsername}" data-userid="${escapeHtmlSafe(user.node.id)}" data-following="${isFollowing ? 'true' : 'false'}"${btnDisabled}>${unfollowText}</button>
            </td>
        </tr>
    `;
}

// Loading ve hata mesajlarını göstermek için yardımcı fonksiyon
function showTableMessage(message, isError = false) {
    if (elements.followingList) {
        elements.followingList.innerHTML = `
            <tr>
                <td colspan="8" class="table-message ${isError ? 'error-message' : ''}">
                    ${message}
                </td>
            </tr>
        `;
    }
}

// Pagination functions
// v2: search (username / full name), filter chips and sort, all client-side over the
// already-loaded list. Pagination still slices the filtered result in renderCurrentPage.
function getFilteredData() {
    const followerIds = new Set(allFollowersList.map(f => f?.node?.id != null ? String(f.node.id) : null).filter(Boolean));
    const followerUsernames = new Set(allFollowersList.map(f => f?.node?.username ? f.node.username.toLowerCase() : null).filter(Boolean));

    const checkIsFollowing = (user) => {
        if (!user || !user.node) return false;
        if (user.node.follows_viewer === true) return true;
        const uid = user.node.id != null ? String(user.node.id) : null;
        if (uid && followerIds.has(uid)) return true;
        const uname = user.node.username ? user.node.username.toLowerCase() : null;
        if (uname && followerUsernames.has(uname)) return true;
        return false;
    };

    let data = allDisplayData.filter(user => {
        const isFollowing = checkIsFollowing(user);
        const isWhitelisted = currentWhitelistSet.has(user.node.username);
        if (showOnlyNonFollowersFilter && isFollowing) return false;
        if (analyzerChipFilter === 'notFollowing' && isFollowing) return false;
        if (analyzerChipFilter === 'following' && !isFollowing) return false;
        if (analyzerChipFilter === 'whitelisted' && !isWhitelisted) return false;
        if (analyzerSearchQuery) {
            const haystack = ((user.node.username || '') + ' ' + (user.node.full_name || '')).toLowerCase();
            if (!haystack.includes(analyzerSearchQuery)) return false;
        }
        return true;
    });
    if (analyzerSortMode === 'username') {
        data = [...data].sort((a, b) => (a.node.username || '').localeCompare(b.node.username || ''));
    } else if (analyzerSortMode === 'notFollowing') {
        // Stable: not-following first, original order kept inside each group.
        data = [...data].sort((a, b) => (checkIsFollowing(a) ? 1 : 0) - (checkIsFollowing(b) ? 1 : 0));
    }
    // NOTE: no "most followers" sort — the following-list data Instagram returns has no
    // per-account follower count (see unfollow-bridge.js: only id/username/full_name/
    // verified/pic). Sorting by it would need one profile request per account.
    return data;
}

// v2: CSV of the current filter (username, full name, verified, following you, whitelisted).
function downloadFilteredCsv() {
    const rows = getFilteredData();
    if (!rows.length) {
        showToast(getMessage('exportCsvEmpty'), 'error');
        return;
    }
    const followerIds = new Set(allFollowersList.map(f => f?.node?.id != null ? String(f.node.id) : null).filter(Boolean));
    const followerUsernames = new Set(allFollowersList.map(f => f?.node?.username ? f.node.username.toLowerCase() : null).filter(Boolean));

    const checkIsFollowing = (user) => {
        if (!user || !user.node) return false;
        if (user.node.follows_viewer === true) return true;
        const uid = user.node.id != null ? String(user.node.id) : null;
        if (uid && followerIds.has(uid)) return true;
        const uname = user.node.username ? user.node.username.toLowerCase() : null;
        if (uname && followerUsernames.has(uname)) return true;
        return false;
    };

    const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    const lines = [['username', 'full_name', 'verified', 'following_you', 'whitelisted'].join(',')];
    for (const user of rows) {
        const n = user.node;
        lines.push([
            esc(n.username), esc(n.full_name || ''), n.is_verified ? 'yes' : 'no',
            checkIsFollowing(user) ? 'yes' : 'no',
            currentWhitelistSet.has(n.username) ? 'yes' : 'no'
        ].join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'insta-unfollow-nonfollowers.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// v2: copy the usernames of the current filter, one per line.
async function copyFilteredUsernames() {
    const rows = getFilteredData();
    if (!rows.length) {
        showToast(getMessage('exportCsvEmpty'), 'error');
        return;
    }
    const text = rows.map(u => u.node.username).join('\n');
    try {
        await navigator.clipboard.writeText(text);
    } catch (e) {
        // Clipboard API needs a user gesture / focus; fall back to a hidden textarea.
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
    }
    const msg = getMessage('copiedUsernames', [String(rows.length)]);
    showToast(msg === 'copiedUsernames' ? `${rows.length} usernames copied` : msg);
}

function renderCurrentPage() {
    updateFilterChipCounts();
    const filtered = getFilteredData();
    totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    if (currentPage > totalPages) currentPage = totalPages;

    const start = (currentPage - 1) * PAGE_SIZE;
    const pageData = filtered.slice(start, start + PAGE_SIZE);

    if (elements.followingList) {
        if (pageData.length === 0) {
            const emptyLabel = analyzerSearchQuery
                ? `No matching accounts for "${escapeHtmlSafe(analyzerSearchQuery)}".`
                : (analyzerChipFilter === 'whitelisted'
                    ? 'No whitelisted accounts yet. Click the shield icon on any row to protect an account from unfollowing.'
                    : (analyzerChipFilter === 'notFollowing'
                        ? '🎉 Everyone shown here follows you back!'
                        : 'No accounts in this filter.'));
            elements.followingList.innerHTML = `
                <tr>
                    <td colspan="7" class="no-data-message">${emptyLabel}</td>
                </tr>
            `;
        } else {
            elements.followingList.innerHTML = pageData.map((user, i) =>
                createTableRow(user, start + i, allFollowersList, currentWhitelistSet)
            ).join('');
        }
    }

    if (window.loadAvatar && elements.followingList) {
        elements.followingList.querySelectorAll('img.profile-image').forEach((img) => {
            loadAvatar(img, img.dataset.orig || img.src);
        });
    }

    renderPaginationControls(filtered.length);
    setupUnfollowListeners();
    setupWhitelistListeners();
}

function renderPaginationControls(totalItems) {
    let container = document.getElementById('paginationControls');
    if (!container) return;

    if (totalPages <= 1) {
        container.style.display = 'none';
        return;
    }
    container.style.display = 'flex';

    const info = `${((currentPage - 1) * PAGE_SIZE) + 1}-${Math.min(currentPage * PAGE_SIZE, totalItems)} / ${totalItems}`;

    let pages = '';
    const maxVisible = 5;
    let startPage = Math.max(1, currentPage - Math.floor(maxVisible / 2));
    let endPage = Math.min(totalPages, startPage + maxVisible - 1);
    if (endPage - startPage < maxVisible - 1) {
        startPage = Math.max(1, endPage - maxVisible + 1);
    }

    if (startPage > 1) {
        pages += `<button class="page-btn" data-page="1">1</button>`;
        if (startPage > 2) pages += `<span class="page-dots">...</span>`;
    }
    for (let p = startPage; p <= endPage; p++) {
        pages += `<button class="page-btn${p === currentPage ? ' active' : ''}" data-page="${p}">${p}</button>`;
    }
    if (endPage < totalPages) {
        if (endPage < totalPages - 1) pages += `<span class="page-dots">...</span>`;
        pages += `<button class="page-btn" data-page="${totalPages}">${totalPages}</button>`;
    }

    container.innerHTML = `
        <button class="page-nav-btn" id="prevPage" ${currentPage <= 1 ? 'disabled' : ''}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"></polyline></svg>
        </button>
        <div class="page-numbers">${pages}</div>
        <button class="page-nav-btn" id="nextPage" ${currentPage >= totalPages ? 'disabled' : ''}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>
        </button>
        <span class="page-info">${info}</span>
    `;

    container.querySelectorAll('.page-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            currentPage = parseInt(btn.dataset.page);
            renderCurrentPage();
            document.querySelector('.table-container')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    });
    document.getElementById('prevPage')?.addEventListener('click', () => {
        if (currentPage > 1) { currentPage--; renderCurrentPage(); }
    });
    document.getElementById('nextPage')?.addEventListener('click', () => {
        if (currentPage < totalPages) { currentPage++; renderCurrentPage(); }
    });
}

// Trend indicator helper
function showTrend(statId, diff) {
    const statEl = document.getElementById(statId);
    if (!statEl) return;
    const parent = statEl.closest('.stat-content') || statEl.closest('.stat-card');
    if (!parent) return;

    const old = parent.querySelector('.trend-indicator');
    if (old) old.remove();

    if (diff === 0) return;

    const isUp = diff > 0;
    const arrow = isUp ? '&#9650;' : '&#9660;';
    const cls = isUp ? 'trend-up' : 'trend-down';
    const text = (isUp ? '+' : '') + diff;

    const el = document.createElement('div');
    el.className = `trend-indicator ${cls}`;
    el.innerHTML = `<span class="trend-arrow">${arrow}</span> ${text}`;
    parent.appendChild(el);
}

let filterListenersInitialized = false;

function updateFilterChipCounts() {
    if (!allDisplayData) return;
    const followerIds = new Set(allFollowersList.map(f => f?.node?.id != null ? String(f.node.id) : null).filter(Boolean));
    const followerUsernames = new Set(allFollowersList.map(f => f?.node?.username ? f.node.username.toLowerCase() : null).filter(Boolean));

    let notFollowingCnt = 0;
    let followingCnt = 0;
    let whitelistedCnt = 0;

    for (const user of allDisplayData) {
        if (!user || !user.node) continue;
        const uid = user.node.id != null ? String(user.node.id) : null;
        const uname = user.node.username ? user.node.username.toLowerCase() : null;
        const isFoll = user.node.follows_viewer === true ||
            (uid && followerIds.has(uid)) ||
            (uname && followerUsernames.has(uname));
        if (isFoll) followingCnt++;
        else notFollowingCnt++;
        if (currentWhitelistSet.has(user.node.username)) whitelistedCnt++;
    }

    const counts = {
        all: allDisplayData.length,
        notFollowing: notFollowingCnt,
        following: followingCnt,
        whitelisted: whitelistedCnt
    };

    document.querySelectorAll('.filter-chip').forEach((chip) => {
        const key = chip.dataset.chip || 'all';
        if (!chip.dataset.baseLabel) {
            chip.dataset.baseLabel = chip.textContent.trim();
        }
        const count = counts[key] ?? 0;
        chip.innerHTML = `<span>${escapeHtmlSafe(chip.dataset.baseLabel)}</span><span class="chip-count">${count}</span>`;
    });
}

function setActiveFilterChip(chipName) {
    analyzerChipFilter = chipName || 'all';
    showOnlyNonFollowersFilter = (analyzerChipFilter === 'notFollowing');
    const filterCheckbox = document.getElementById('showOnlyNonFollowers');
    if (filterCheckbox) filterCheckbox.checked = showOnlyNonFollowersFilter;

    document.querySelectorAll('.filter-chip').forEach((c) => {
        const isSelected = (c.dataset.chip || 'all') === analyzerChipFilter;
        c.classList.toggle('active', isSelected);
        c.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
    });
}

// Filter + toolbar event listeners (idempotent — bound once)
function setupFilterListener() {
    if (filterListenersInitialized) return;
    filterListenersInitialized = true;

    const filterCheckbox = document.getElementById('showOnlyNonFollowers');
    if (filterCheckbox) {
        filterCheckbox.addEventListener('change', function() {
            setActiveFilterChip(this.checked ? 'notFollowing' : 'all');
            currentPage = 1;
            renderCurrentPage();
        });
    }
    const searchInput = document.getElementById('analyzerSearch');
    if (searchInput) {
        searchInput.addEventListener('input', function() {
            analyzerSearchQuery = this.value.trim().toLowerCase();
            currentPage = 1;
            renderCurrentPage();
        });
    }
    const sortSelect = document.getElementById('analyzerSort');
    if (sortSelect) {
        sortSelect.addEventListener('change', function() {
            analyzerSortMode = this.value;
            currentPage = 1;
            renderCurrentPage();
        });
    }
    document.querySelectorAll('.filter-chip').forEach(chip => {
        chip.addEventListener('click', function() {
            setActiveFilterChip(this.dataset.chip || 'all');
            currentPage = 1;
            renderCurrentPage();
        });
    });
    document.getElementById('exportCsvBtn')?.addEventListener('click', downloadFilteredCsv);
    document.getElementById('copyUsernamesBtn')?.addEventListener('click', copyFilteredUsernames);
}

// Daily scan limit helper functions (per Instagram account) - CUMULATIVE LIMIT
/**
 * What a free account may see on its first day, and what each later day adds.
 *
 * Named because the numbers appear in six places between the limit reader and its repair paths,
 * and a change that reaches five of them leaves the account in a state no branch agrees on.
 */
const FREE_FIRST_DAY_SCANS = 40;
const FREE_DAILY_ADD = 20;

// Free plan unfollow cap: 50 per day per Instagram account, reset at midnight local time.
// Premium members have no cap. Counting happens on successful unfollows only.
const FREE_DAILY_UNFOLLOWS = 50;

async function getDailyScanLimit(userId) {
    if (!userId) return null;
    
    const data = await chrome.storage.local.get(['dailyScanLimits']);
    const membership = await getPremiumMembership();
    const isPremium = membership.turu === 'premium' || membership.turu === 'Premium';
    
    if (isPremium) {
        return { totalLimit: Infinity, daysUsed: 0, isFirstDay: false, isTrialActive: false };
    }

    const today = new Date().toDateString();
    const allLimits = data.dailyScanLimits || {};
    const limitData = allLimits[userId] || {};
    
    // Day reset check - add new limit if new day
    if (limitData.lastResetDate !== today) {
        // New day - add to cumulative limit
        const isFirstDay = !limitData.lastResetDate; // First use for this account?
        const daysUsed = (limitData.daysUsed || 0) + 1;
        const dailyAdd = isFirstDay ? FREE_FIRST_DAY_SCANS : FREE_DAILY_ADD;
        const previousTotal = limitData.totalLimit || 0;
        const newTotalLimit = previousTotal + dailyAdd;
        
        const updatedLimits = {
            ...allLimits,
            [userId]: {
                lastResetDate: today,
                totalLimit: newTotalLimit,
                daysUsed: daysUsed,
                isFirstDay: isFirstDay,
                dailyAdd: dailyAdd // How much was added today
            }
        };
        
        await chrome.storage.local.set({ dailyScanLimits: updatedLimits });
        
        return { 
            totalLimit: newTotalLimit, 
            daysUsed: daysUsed,
            isFirstDay: isFirstDay,
            dailyAdd: dailyAdd,
            isTrialActive: false
        };
    }
    
    // Same day - return existing cumulative limit
    // If totalLimit is 0 or undefined, it means first day wasn't initialized properly
    let totalLimit = limitData.totalLimit;
    if (!totalLimit || totalLimit === 0) {
        // `daysUsed` counts from 1, never 0 — so the old test here (`=== 0 || === undefined`)
        // called a corrupted first day "not the first day" and repaired it to the smaller daily
        // amount, while the return below and the banner both still called it the first day. The
        // user was told about a bonus they had just been quietly repaired out of.
        const isFirstDay = !limitData.lastResetDate || !limitData.daysUsed || limitData.daysUsed === 1;
        totalLimit = isFirstDay ? FREE_FIRST_DAY_SCANS : FREE_DAILY_ADD;
        
        // Update storage with correct value
        const updatedLimits = {
            ...allLimits,
            [userId]: {
                ...limitData,
                totalLimit: totalLimit,
                isFirstDay: isFirstDay,
                daysUsed: isFirstDay ? 1 : (limitData.daysUsed || 1),
                dailyAdd: isFirstDay ? FREE_FIRST_DAY_SCANS : FREE_DAILY_ADD
            }
        };
        await chrome.storage.local.set({ dailyScanLimits: updatedLimits });
    }
    
    return { 
        totalLimit: totalLimit, 
        daysUsed: limitData.daysUsed || 1,
        isFirstDay: limitData.isFirstDay !== undefined ? limitData.isFirstDay : (limitData.daysUsed === 1 || limitData.daysUsed === undefined),
        dailyAdd: limitData.dailyAdd || (limitData.isFirstDay ? FREE_FIRST_DAY_SCANS : FREE_DAILY_ADD),
        isTrialActive: false
    };
}

// Daily unfollow allowance (per Instagram account), in the same shape as the scan limit so one
// plan means one thing. Premium is unlimited; free gets FREE_DAILY_UNFOLLOWS (+ optional 100 review bonus).
async function getDailyUnfollowAllowance(userId) {
    if (!userId) return null;

    const membership = await getPremiumMembership();
    const isPremium = membership.turu === 'premium' || membership.turu === 'Premium';
    if (isPremium) {
        return { isPremium: true, used: 0, remaining: Infinity, total: Infinity, reviewBonus: 0 };
    }

    const data = await chrome.storage.local.get(['dailyUnfollowLimits', 'review_bonus_unfollows']);
    const allLimits = data.dailyUnfollowLimits || {};
    const reviewBonus = Number(data.review_bonus_unfollows) || 0;
    const baseTotal = FREE_DAILY_UNFOLLOWS + reviewBonus;
    const today = new Date().toDateString();
    const record = allLimits[userId] || {};

    if (record.date !== today) {
        await chrome.storage.local.set({
            dailyUnfollowLimits: { ...allLimits, [userId]: { date: today, used: 0 } }
        });
        return { isPremium: false, used: 0, remaining: baseTotal, total: baseTotal, reviewBonus: reviewBonus };
    }

    const used = record.used || 0;
    return {
        isPremium: false,
        used: used,
        remaining: Math.max(0, baseTotal - used),
        total: baseTotal,
        reviewBonus: reviewBonus
    };
}

// Count a successful unfollow against today's allowance for this account.
async function recordUnfollowUsed(userId) {
    if (!userId) return;

    const data = await chrome.storage.local.get(['dailyUnfollowLimits']);
    const allLimits = data.dailyUnfollowLimits || {};
    const today = new Date().toDateString();
    const record = allLimits[userId] || {};
    const used = record.date === today ? (record.used || 0) + 1 : 1;

    await chrome.storage.local.set({
        dailyUnfollowLimits: { ...allLimits, [userId]: { date: today, used } }
    });

    // Track for smart review prompt milestone
    if (window.ReviewPrompt && typeof window.ReviewPrompt.trackSuccessfulUnfollow === 'function') {
        window.ReviewPrompt.trackSuccessfulUnfollow();
    }
}

// Show daily limit info in UI - Basit ve anlaşılır uyarı
function showDailyLimitInfo(limitInfo, totalFollowing) {
    const limitMessageContainer = document.getElementById('limitMessageContainer');
    if (!limitMessageContainer) return;
    
    if (limitInfo.totalLimit === Infinity) {
        limitMessageContainer.style.display = 'none';
        return;
    }
    
    const displayedCount = Math.min(totalFollowing, limitInfo.totalLimit);
    const hiddenCount = Math.max(0, totalFollowing - limitInfo.totalLimit);
    const isFirstDay = limitInfo.isFirstDay;
    
    // Geri sayım hesapla (saniyeli)
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    
    const getCountdown = () => {
        const diff = tomorrow - new Date();
        const hours = Math.floor(diff / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((diff % (1000 * 60)) / 1000);
        return { hours, minutes, seconds };
    };
    
    const countdown = getCountdown();
    // Format countdown text - simple format: "5h 30m 15s later"
    const laterText = getMessage('later');
    const countdownParts = [];
    if (countdown.hours > 0) countdownParts.push(`${countdown.hours}h`);
    if (countdown.minutes > 0) countdownParts.push(`${countdown.minutes}m`);
    if (countdown.seconds > 0) countdownParts.push(`${countdown.seconds}s`);
    const countdownText = countdownParts.join(' ') + ' ' + laterText;
    
    // Kompakt ve açıklayıcı mesaj
    const limitTitle = getMessage('dailyLimitTitle');
    const mainMessage = hiddenCount > 0
        ? getMessage('freePlanTodayMessage', [displayedCount.toString(), hiddenCount.toString()])
        : getMessage('freePlanTodayMessageNoHidden', [displayedCount.toString()]);

    const dailyInfo = isFirstDay
        ? getMessage('firstDayBonusMessage', [countdownText])
        : getMessage('dailyLimitMessage', [countdownText]);
    
    const premiumMessage = getMessage('premiumUnlockAllMessage', [totalFollowing.toString()]);
    
    limitMessageContainer.innerHTML = `
        <div class="simple-limit-banner">
            <div class="limit-banner-content">
                <div class="limit-banner-icon" aria-hidden="true" style="color: #F59E0B; background: rgba(245, 158, 11, 0.1); padding: 8px; border-radius: 12px;">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                        <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                    </svg>
                </div>
                <div class="limit-banner-text">
                    <div class="limit-banner-title">${limitTitle}</div>
                    <div class="limit-banner-main">${mainMessage}</div>
                    <div class="limit-banner-daily">${dailyInfo}</div>
                    <div class="limit-banner-premium">${premiumMessage}</div>
                </div>
            </div>
            <button class="limit-banner-premium-btn" data-upgrade="true">
                <span class="premium-btn-icon">✨</span>
                <span class="premium-btn-text">${getMessage('upgradeToPremiumButton')}</span>
                <span class="premium-btn-arrow">→</span>
            </button>
        </div>
    `;
    limitMessageContainer.style.display = 'block';
    
    // Premium butonuna tıklama eventi
    const premiumBtn = limitMessageContainer.querySelector('[data-upgrade="true"]');
    if (premiumBtn) {
        premiumBtn.addEventListener('click', () => {
            const upgradeBtn = document.getElementById('upgradeToPremiumBtn');
            if (upgradeBtn) {
                upgradeBtn.click();
            }
        });
    }
    
    // Geri sayımı güncelle (her saniye)
    updateCountdown(limitMessageContainer);
    const countdownInterval = setInterval(() => {
        if (limitMessageContainer.style.display === 'none') {
            clearInterval(countdownInterval);
            return;
        }
        updateCountdown(limitMessageContainer);
    }, 1000); // Her saniye güncelle
}

// Geri sayımı güncelle (saniyeli)
function updateCountdown(container) {
    const dailyInfoElement = container.querySelector('.limit-banner-daily');
    if (!dailyInfoElement) return;
    
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    
    const diff = tomorrow - now;
    
    // Eğer süre dolduysa, yeni gün başlamış demektir
    if (diff <= 0) {
        // Sayfayı yenile veya limiti güncelle
        location.reload();
        return;
    }
    
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diff % (1000 * 60)) / 1000);
    
    // Format countdown text - simple format: "5h 30m 15s later"
    const laterText = getMessage('later');
    const countdownParts = [];
    if (hours > 0) countdownParts.push(`${hours}h`);
    if (minutes > 0) countdownParts.push(`${minutes}m`);
    if (seconds > 0) countdownParts.push(`${seconds}s`);
    const countdownFormatted = countdownParts.join(' ') + ' ' + laterText;
    
    // Check if first day by checking if the element contains first day message key
    // Use a more reliable method: check the parent container for a data attribute or check initial text
    const limitContainer = container.closest('.simple-limit-banner');
    const isFirstDay = dailyInfoElement.textContent.includes(getMessage('firstDayBonus').split(' ')[0]) || 
                      dailyInfoElement.textContent.includes('İlk gün') ||
                      dailyInfoElement.textContent.includes('First day') ||
                      (limitContainer && limitContainer.dataset.isFirstDay === 'true');
    
    const newText = isFirstDay
        ? getMessage('firstDayBonusMessage', [countdownFormatted])
        : getMessage('dailyLimitMessage', [countdownFormatted]);
    
    dailyInfoElement.textContent = newText;
}

// Show footer info about list continuation - Basitleştirilmiş
function showListFooterInfo(limitInfo, totalFollowing, displayedCount) {
    const footerInfo = document.getElementById('listFooterInfo');
    if (!footerInfo) return;
    
    if (limitInfo.totalLimit === Infinity) {
        footerInfo.style.display = 'none';
        return;
    }
    
    // Only show if there are more accounts than displayed
    if (totalFollowing > displayedCount) {
        const remaining = totalFollowing - displayedCount;
        
        footerInfo.innerHTML = `
            <div class="premium-footer-card">
                <div class="premium-footer-content">
                    <div class="premium-footer-icon">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"></path>
                        </svg>
                    </div>
                    <div class="premium-footer-text">
                        <span class="premium-footer-message">${getMessage('accountsRemaining', [remaining.toString()])}</span>
                    </div>
                </div>
                <button class="premium-footer-button" id="footerPremiumButton">
                    <svg class="premium-footer-btn-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"></path>
                    </svg>
                    <span class="premium-footer-btn-text">${getMessage('upgradeToPremiumButton')}</span>
                    <svg class="premium-footer-btn-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                        <line x1="5" y1="12" x2="19" y2="12"></line>
                        <polyline points="12 5 19 12 12 19"></polyline>
                    </svg>
                </button>
            </div>
        `;
        footerInfo.style.display = 'block';
        
        // Add click event to footer button
        const footerButton = footerInfo.querySelector('#footerPremiumButton');
        if (footerButton) {
            footerButton.addEventListener('click', function() {
                openPremiumModal();
            });
        }
    } else {
        footerInfo.style.display = 'none';
    }
}

async function initializeFollowingList(forceRefresh = false) {
    try {
        if (elements.loadingIndicator) {
            elements.loadingIndicator.style.display = 'flex';
            elements.loadingCount.textContent = getMessage('startingAnalysis');
            const detail = document.getElementById('loadingDetail');
            if (detail) detail.textContent = '';
            // Nothing is known yet, so the ring sweeps instead of sitting at "--". A panel that
            // shows a dash and never moves is indistinguishable from one that has frozen.
            beginIndeterminate();
        }
        if (elements.followingList) {
            elements.followingList.style.opacity = '0.5';
        }

        // Hide reanalyze group on new load
        const reAnalyzeGroup = document.getElementById('reAnalyzeGroup');
        if (reAnalyzeGroup) reAnalyzeGroup.style.display = 'none';

        const userId = await getCurrentUserId();
        if (!userId) {
            showTableMessage(
                getMessage('pleaseLoginToInstagram') +
                '<br><br>Open <b>instagram.com</b> in this Chrome browser and log in, then run the ' +
                'analysis again. The app reads your Instagram data through that logged-in session, ' +
                'exactly like the original app did — there is no other way to reach the data.',
                true
            );
            return;
        }
        currentUserId = userId;

        // Membership kontrolü
        const membership = await getPremiumMembership();
        const isPremium = membership.turu === 'premium' || membership.turu === 'Premium';

        let followingList, followersList;
        let fromCache = false;

        // Check cache first (unless force refresh)
        if (!forceRefresh) {
            const cache = await getAnalysisCache(userId);
            if (cache && cache.followingList && cache.followingList.length > 0) {
                showCacheLoadingState();
                followingList = cache.followingList;
                followersList = cache.followersList;
                fromCache = true;
                // A cache written by the follows_viewer path carries the real follower total,
                // because its followersList cannot be counted for one.
                realFollowersTotal = cache.followersTotal ?? null;
                usedFollowsViewer = cache.followersTotal != null;
                // getAnalysisCache only returns pairs that were read end to end, so a cache hit is
                // as trustworthy as a fresh scan for the purposes of the diff and the bulk actions.
                lastScanInfo.followers = { complete: true, reason: 'cache', count: followersList.length };
                lastScanInfo.following = { complete: true, reason: 'cache', count: followingList.length };

                // Show cache time next to re-analyze button
                const cacheTime = new Date(cache.timestamp);
                const timeStr = cacheTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                const cacheInfoText = document.getElementById('cacheInfoText');
                if (cacheInfoText) {
                    cacheInfoText.textContent = getMessage('cachedDataInfo', [timeStr]);
                }

                // Show expiry warning if cache is older than 4 days
                const cacheAgeDays = Math.floor((Date.now() - cache.timestamp) / (1000 * 60 * 60 * 24));
                const cacheExpiryWarning = document.getElementById('cacheExpiryWarning');
                if (cacheExpiryWarning && cacheAgeDays >= 4) {
                    const cacheExpiryText = document.getElementById('cacheExpiryText');
                    if (cacheExpiryText) cacheExpiryText.textContent = getMessage('cacheExpiryWarning', [cacheAgeDays.toString()]);
                    cacheExpiryWarning.style.display = 'block';
                    const cacheExpiryBtn = document.getElementById('cacheExpiryReanalyze');
                    if (cacheExpiryBtn) {
                        cacheExpiryBtn.addEventListener('click', () => {
                            cacheExpiryWarning.style.display = 'none';
                            document.getElementById('reAnalyzeBtn')?.click();
                        }, { once: true });
                    }
                }
            }
        }

        // Fetch fresh data if no cache or force refresh
        if (!fromCache) {
            if (forceRefresh) {
                cachedExpected = null;
                cachedViewer = null;
                if (window.IgSession && typeof window.IgSession._resetCache === 'function') {
                    window.IgSession._resetCache();
                }
            }
            usedFollowsViewer = false;
            realFollowersTotal = null;

            const expectedFollowers = await getExpectedOnce(userId, 'followers');
            // For normal-sized accounts (<= 1,500 followers), read BOTH actual lists directly via
            // Instagram's follower/following endpoints for 100% literal ID + username ground truth.
            // For large accounts (> 1,500 followers), try the spot-verified status query first so
            // scanning stays fast without hitting follower pagination limits.
            const preferDirectTwoList = expectedFollowers != null && expectedFollowers <= 1500;

            if (preferDirectTwoList) {
                followersList = await getFollowersList(userId);
                if (lastScanInfo.followers?.complete) {
                    followingList = await getFollowingList(userId);
                } else {
                    // Followers endpoint throttled — try verified status path before reporting incomplete
                    const withStatus = await readFollowingWithStatus(userId);
                    if (withStatus) {
                        usedFollowsViewer = true;
                        followingList = withStatus.users;
                        followersList = withStatus.users.filter((u) => u.node.follows_viewer === true);
                        realFollowersTotal = expectedFollowers;
                        lastScanInfo.following = {
                            complete: true, reason: withStatus.reason, count: followingList.length,
                            source: withStatus.source, requests: withStatus.requests
                        };
                        lastScanInfo.followers = {
                            complete: true, reason: 'follows_viewer', count: followersList.length
                        };
                    } else {
                        followingList = [];
                    }
                }
            } else {
                const withStatus = await readFollowingWithStatus(userId);
                if (withStatus) {
                    usedFollowsViewer = true;
                    followingList = withStatus.users;
                    followersList = withStatus.users.filter((u) => u.node.follows_viewer === true);
                    realFollowersTotal = expectedFollowers;

                    lastScanInfo.following = {
                        complete: true, reason: withStatus.reason, count: followingList.length,
                        source: withStatus.source, requests: withStatus.requests
                    };
                    lastScanInfo.followers = {
                        complete: true, reason: 'follows_viewer', count: followersList.length
                    };
                } else {
                    followersList = await getFollowersList(userId, {
                        preferGraphql: expectedFollowers != null && expectedFollowers > 1500
                    });
                    followingList = lastScanInfo.followers?.complete
                        ? await getFollowingList(userId)
                        : [];
                }
            }

            // Stamp explicit boolean `follows_viewer` onto `followingList` from the two-list diff
            // as well, so every downstream check agrees 100% regardless of which scan path ran.
            if (!usedFollowsViewer && followingList.length > 0 && isDataComplete()) {
                const fIds = new Set(followersList.map(f => f?.node?.id != null ? String(f.node.id) : '').filter(Boolean));
                const fNames = new Set(followersList.map(f => f?.node?.username ? f.node.username.toLowerCase() : '').filter(Boolean));
                for (const u of followingList) {
                    if (!u || !u.node) continue;
                    const uid = u.node.id != null ? String(u.node.id) : '';
                    const uname = u.node.username ? u.node.username.toLowerCase() : '';
                    u.node.follows_viewer = (uid && fIds.has(uid)) || (uname && fNames.has(uname)) || false;
                }
            }

            // Only a complete pair is worth keeping.
            if (followingList.length > 0 && isDataComplete()) {
                await saveAnalysisCache(userId, followingList, followersList, realFollowersTotal);
            }
        }

        // Show re-analyze group
        if (reAnalyzeGroup) {
            reAnalyzeGroup.style.display = 'flex';
        }
        const reAnalyzeBtn = document.getElementById('reAnalyzeBtn');
        if (reAnalyzeBtn) {
            reAnalyzeBtn.disabled = false;
            reAnalyzeBtn.querySelector('.btn-reanalyze-text').textContent = getMessage('reAnalyze');
        }
        // Clear time text and expiry warning if fresh analysis
        if (!fromCache) {
            const cacheInfoText = document.getElementById('cacheInfoText');
            if (cacheInfoText) cacheInfoText.textContent = '';
            const cacheExpiryWarning = document.getElementById('cacheExpiryWarning');
            if (cacheExpiryWarning) cacheExpiryWarning.style.display = 'none';
        }

        if (followingList.length === 0) {
            showTableMessage(getMessage('couldNotFetchFollowing'), true);
            return;
        }

        // Instagram stopped part way through, so the two lists cannot be compared. The table is not
        // rendered at all: "Following You" is a verdict derived from the difference between them,
        // and a wrong verdict is actionable — the per-row Unfollow button sits right next to it.
        // Gating only the bulk buttons would leave the same mistake available one click at a time.
        if (!isDataComplete()) {
            if (elements.loadingIndicator) elements.loadingIndicator.style.display = 'none';
            if (elements.followingList) elements.followingList.style.opacity = '1';
            showScanNotice(describeScanFailure());
            console.warn('[bridge] eksik veri, tablo gosterilmedi:', lastScanInfo);
            return;
        }

        // Premium değilse GÜNLÜK limit uygula (userId bazlı)
        let displayList = followingList;
        let isLimited = false;
        
        // Upgrade butonunu premium durumuna göre güncelle
        const upgradeBtn = document.getElementById('upgradeToPremiumBtn');
        if (upgradeBtn) {
            if (isPremium) {
                upgradeBtn.textContent = getMessage('manageSubscription');
            } else {
                upgradeBtn.textContent = getMessage('upgradeToPremium');
            }
        }
        
        if (!isPremium) {
            let dailyLimit = await getDailyScanLimit(userId);

            if (!dailyLimit || dailyLimit.totalLimit === undefined) {
                // Fallback: if limit data is corrupted, start fresh
                const today = new Date().toDateString();
                await chrome.storage.local.set({
                    dailyScanLimits: {
                        [userId]: {
                            lastResetDate: today,
                            totalLimit: FREE_FIRST_DAY_SCANS,
                            daysUsed: 1,
                            isFirstDay: true,
                            dailyAdd: FREE_FIRST_DAY_SCANS
                        }
                    }
                });
                const freshLimit = await getDailyScanLimit(userId);
                if (!freshLimit) {
                    showTableMessage(getMessage('errorOccurred'), true);
                    return;
                }
                dailyLimit = freshLimit;
            }

            // Cumulative limit - prioritize non-followers first when slicing for free accounts
            // so non-followers are never hidden behind mutual friends in the first N rows!
            const maxToShow = Math.min(
                followingList.length,
                dailyLimit.totalLimit || 50
            );
            const prioritizedFollowing = [...followingList].sort((a, b) =>
                (isUserFollowingMe(a, followersList) ? 1 : 0) - (isUserFollowingMe(b, followersList) ? 1 : 0)
            );

            displayList = prioritizedFollowing.slice(0, maxToShow);
            isLimited = followingList.length > maxToShow;

            // UI'da limit bilgisi göster
            showDailyLimitInfo(dailyLimit, followingList.length);

            // Footer mesajını göster
            showListFooterInfo(dailyLimit, followingList.length, displayList.length);

            // Premium uyarısını gizle
            const premiumWarning = document.getElementById('premiumLimitWarning');
            if (premiumWarning) {
                premiumWarning.style.display = 'none';
            }
        } else {
            // Premium uyarısını gizle
            const premiumWarning = document.getElementById('premiumLimitWarning');
            if (premiumWarning) {
                premiumWarning.style.display = 'none';
            }
        }

        // Load whitelist and store globally
        const whitelistArr = await getWhitelist(userId);
        currentWhitelistSet = new Set(whitelistArr);

        // Store data globally for pagination
        allDisplayData = displayList;
        allFollowersList = followersList;
        // Kept unsliced: displayList may be capped for free accounts, and the probe needs the
        // complete picture to be sure the account it picks really is not followed.
        allFollowingFull = followingList;
        currentPage = 1;
        setActiveFilterChip('all');

        // Render first page
        renderCurrentPage();
        renderScanDiag();

        // Check if user is eligible for smart review & bonus unfollows banner
        if (window.ReviewPrompt && typeof window.ReviewPrompt.shouldShowPrompt === 'function') {
            window.ReviewPrompt.shouldShowPrompt().then((shouldShow) => {
                if (shouldShow && allDisplayData.length > 0) {
                    setTimeout(() => window.ReviewPrompt.renderBanner(), 2000);
                }
            }).catch(() => {});
        }

        // Eğer limit varsa bilgi mesajı göster (tablo dışında)
        const limitMessageContainer = document.getElementById('limitMessageContainer');
        if (!isLimited && limitMessageContainer) {
            limitMessageContainer.style.display = 'none';
        }

        // Premium ise footer'ı gizle
        if (isPremium) {
            const footerInfo = document.getElementById('listFooterInfo');
            if (footerInfo) {
                footerInfo.style.display = 'none';
            }
        }

        // Takipçi, takip edilen ve takip etmeyen sayılarını güncelle
        const nonFollowers = findNonFollowers(followingList, followersList);
        
        // On the follows_viewer path `followersList` holds only the followers who are also followed
        // back, so counting it would show a number far below the real one. Instagram's own figure
        // is used instead — which is also the more accurate of the two, since it does not depend
        // on a scrape finishing.
        followersCount = (usedFollowsViewer && realFollowersTotal != null)
            ? realFollowersTotal
            : followersList.length;
        followingCount = followingList.length;
        nonFollowersCount = nonFollowers.length;
        
        if (elements.followersCount) {
            elements.followersCount.textContent = followersCount.toLocaleString();
        }
        if (elements.followingCount) {
            elements.followingCount.textContent = followingCount.toLocaleString();
        }
        if (elements.nonFollowersCount) {
            elements.nonFollowersCount.textContent = nonFollowersCount.toLocaleString();
        }

        // Show trend comparison with the last analysis (v2: was comparing with the
        // analysis before that — prevSnapshot.previous — skipping the most recent one)
        const prevSnapshot = await getLastAnalysisSnapshot(userId);
        if (prevSnapshot) {
            showTrend('followersCount', followersCount - prevSnapshot.followersCount);
            showTrend('followingCount', followingCount - prevSnapshot.followingCount);
            showTrend('nonFollowersCount', nonFollowersCount - prevSnapshot.nonFollowersCount);
            const trendEl = document.getElementById('nonFollowersTrend');
            if (trendEl) {
                const diff = nonFollowersCount - prevSnapshot.nonFollowersCount;
                const dateStr = new Date(prevSnapshot.timestamp).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
                // Uses the trendUp / trendDown / trendNoChange strings that already
                // existed in _locales/en (v1 defined them but never displayed them).
                let text;
                if (diff === 0) text = getMessage('trendNoChange');
                else if (diff > 0) text = getMessage('trendUp', [String(diff)]);
                else text = getMessage('trendDown', [String(diff)]);
                trendEl.textContent = text + ' · ' + dateStr;
            }
        }

        // Save current snapshot (only on fresh analysis)
        if (!fromCache) {
            await saveAnalysisSnapshot(userId, followersCount, followingCount, nonFollowersCount);
        }

        if (elements.loadingCount) {
            elements.loadingCount.textContent = getMessage('finalizingAnalysis');
            const detail = document.getElementById('loadingDetail');
            if (detail) detail.textContent = '';
        }

        await new Promise(resolve => setTimeout(resolve, 600));

        if (elements.loadingIndicator) {
            elements.loadingIndicator.style.display = 'none';
        }
        if (elements.followingList) {
            elements.followingList.style.opacity = '1';
        }

        setupFilterListener();

    } catch (error) {
        console.error('Error:', error);
        if (elements.loadingIndicator) {
            elements.loadingIndicator.style.display = 'none';
        }
        if (elements.followingList) {
            elements.followingList.style.opacity = '1';
        }

        // Show re-analyze button so user can retry
        const reAnalyzeGroup = document.getElementById('reAnalyzeGroup');
        if (reAnalyzeGroup) reAnalyzeGroup.style.display = 'flex';
        const reAnalyzeBtn = document.getElementById('reAnalyzeBtn');
        if (reAnalyzeBtn) {
            reAnalyzeBtn.disabled = false;
            reAnalyzeBtn.querySelector('.btn-reanalyze-text').textContent = getMessage('reAnalyze');
        }

        const errorMsg = error.message || getMessage('errorFetchingData');
        showTableMessage(errorMsg, true);
        showToast(errorMsg, 'error');
    }
}

/**
 * The session's csrf token, fetched once.
 *
 * It used to be re-fetched for every single unfollow, which on a bulk run meant one extra request
 * per account against an endpoint that throttles. The token does not change between them.
 */
let cachedCsrfToken = null;
async function getCsrfTokenOnce() {
    if (cachedCsrfToken) return cachedCsrfToken;
    // Prefer the viewer already fetched for this analysis (its csrf token came with it);
    // otherwise ask the session bootstrap, which reads it off the Instagram homepage.
    const viewer = await getViewerOnce().catch(() => null);
    if (viewer?.csrfToken) {
        cachedCsrfToken = viewer.csrfToken;
        return cachedCsrfToken;
    }
    const session = await window.IgSession.fetchSession();
    cachedCsrfToken = session.csrfToken || null;
    return cachedCsrfToken;
}

/**
 * Ask Instagram whether it will accept an unfollow at all, before the user commits to a run.
 *
 * The support problem this exists for: a user starts a bulk run, it fails, they unfollow the same
 * account by hand and it works, and they conclude the extension is broken. The failure is real, but
 * the damage is done by the surprise. Finding out first turns "this thing doesn't work" into "the
 * app told me what was happening".
 *
 * The probe is a genuine no-op: it unfollows somebody the account does not follow, which changes
 * nothing and always answers `ok` on a healthy path.
 *
 * @returns {Promise<'open'|'blocked'|'unknown'>}
 */
let cachedWriteProbe = null;
let writeProbeAt = 0;

/**
 * How long a "blocked" answer is trusted before the path is tried again.
 *
 * "Open" can be remembered for the session — a path that worked does not un-work on its own. A
 * "blocked" answer must expire: these pauses lift by themselves, often within a couple of minutes,
 * and a verdict cached for the life of the page means the only way out is to reload it. That is a
 * working extension telling a working account it is broken.
 */
const WRITE_PROBE_BLOCKED_TTL_MS = 90000;

function rememberWriteProbe(value) {
    cachedWriteProbe = value;
    writeProbeAt = Date.now();
    console.log('[bridge] yazma yolu:', value);
    return value;
}

/**
 * Find an account the probe can safely unfollow: one that follows this account but is not
 * followed back, so the request changes nothing whatever it answers.
 *
 * On the two-list path `allFollowersList` is the whole followers list and the target is already
 * in memory. On the follows_viewer path it is not: that list holds only the followers who are
 * also followed back, so by construction every entry is in `following` and no target could ever
 * be found there — the probe would quietly return 'unknown' every time and the pre-flight check
 * would stop existing without anything on screen saying so.
 *
 * So when memory cannot supply one, a single page of followers is read for the purpose. One
 * request, and only when a bulk run is about to start.
 */
async function findWriteProbeTarget(followingIds, followingUsernames) {
    const isAlreadyFollowed = (f) => {
        const fid = f?.node?.id != null ? String(f.node.id) : '';
        const funame = f?.node?.username ? f.node.username.toLowerCase() : '';
        if (!fid || !funame) return true;
        if (followingIds.has(fid)) return true;
        if (followingUsernames.has(funame)) return true;
        return false;
    };

    const fromMemory = allFollowersList.find((f) => !isAlreadyFollowed(f));
    if (fromMemory) return fromMemory;

    const viewer = await getViewerOnce();
    let sample;
    try {
        // One page is enough: any follower who is not followed back will do, and on an account
        // whose two lists differ at all the first page almost always contains one.
        sample = await window.UnfollowBridge.readFollowersSample({
            userId: viewer?.id,
            csrfToken: viewer?.csrfToken
        });
    } catch (error) {
        return null;
    }
    if (!sample?.length) return null;
    // Nothing found is a real answer, not a failure: an account that follows back everyone it is
    // followed by has no safe target, and the probe correctly reports 'unknown' rather than
    // unfollowing somebody to find out.
    return sample.find((f) => !isAlreadyFollowed(f)) || null;
}

async function probeWritePath() {
    if (cachedWriteProbe === 'open') return 'open';
    if (cachedWriteProbe === 'blocked' && Date.now() - writeProbeAt < WRITE_PROBE_BLOCKED_TTL_MS) {
        return 'blocked';
    }

    // Someone who follows this account but is not followed back: unfollowing them is a no-op.
    // Built from the complete following list, never the display slice — a wrong answer here would
    // mean really unfollowing somebody during a check that is supposed to change nothing.
    if (!allFollowingFull.length || lastScanInfo.following?.complete === false) return 'unknown';
    const followingIds = new Set(allFollowingFull.map((u) => u?.node?.id != null ? String(u.node.id) : '').filter(Boolean));
    const followingUsernames = new Set(allFollowingFull.map((u) => u?.node?.username ? u.node.username.toLowerCase() : '').filter(Boolean));
    const target = await findWriteProbeTarget(followingIds, followingUsernames);
    if (!target || !target.node?.id || !target.node?.username) return 'unknown';

    // Server-side verification before firing the write probe: guarantee we do NOT follow or have an
    // outgoing follow request to this target, even if in-memory lists lagged by a second.
    if (typeof window.UnfollowBridge?.checkFriendshipStatus === 'function') {
        const csrfToken = await getCsrfTokenOnce().catch(() => null);
        const rel = await window.UnfollowBridge.checkFriendshipStatus(target.node.id, csrfToken);
        if (!rel || !rel.ok || rel.following !== false || rel.outgoingRequest === true) {
            return 'unknown';
        }
    } else {
        return 'unknown';
    }

    try {
        // Probes the same two endpoints the real unfollow uses, in the same order, so the answer
        // reflects what a run would actually meet rather than one path's health. A no-op on a
        // non-followed account, so it must never spend the free plan's daily unfollow quota.
        await unfollowUser(target.node.username, target.node.id, { countQuota: false });
        return rememberWriteProbe('open');
    } catch (error) {
        if (error.code === 'SESSION_EXPIRED') throw error;
        // Every doubt resolves in favour of letting the run start. The probe exists to save the
        // user a wasted run, not to stand between them and a feature that may well be working: a
        // real refusal will be met by the run itself, which stops and says so honestly.
        if (error.code === 'RATE_LIMIT') return rememberWriteProbe('blocked');
        return 'unknown';                 // network trouble, no csrf, anything unexpected
    }
}

/**
 * Tell the user their account is being held back, before they spend a run finding out.
 *
 * Names the manual route explicitly. They will find it anyway — the difference between hearing it
 * here and discovering it themselves is the difference between a working app and a refund.
 */
/**
 * @returns {Promise<boolean>} true when the user chose to start the run regardless.
 *
 * The override is the point. This verdict comes from a single probe request, and a single request
 * can be wrong — a momentary refusal, an endpoint having a bad minute. Without a way past it, one
 * wrong answer turns the whole feature off with no recourse and the extension looks broken. The run
 * itself still stops honestly if the refusal was real, so the worst case of trying anyway is the
 * message they already have.
 */
async function warnWritePathBlocked() {
    return await showCustomModal({
        icon: 'warning',
        title: getMessage('writeBlockedTitle') || 'Instagram is limiting unfollows right now',
        message: getMessage('writeBlockedMessage')
            || 'Instagram has temporarily stopped accepting automatic unfollows on this account. '
             + 'This is temporary and there is nothing wrong with your account.\n\n'
             + 'You can still unfollow from a profile page by hand while it lasts, and your list '
             + 'stays here — nothing has been used up.',
        confirmText: getMessage('tryAnyway') || 'Try anyway',
        cancelText: getMessage('gotIt') || 'OK'
    });
}

/** Resolve a username to an id, for the rare caller that does not already hold one. */
async function resolveUserId(username) {
    const response = await fetch(
        `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
        {
            method: 'GET',
            credentials: 'include',
            headers: {
                'accept': '*/*',
                'x-requested-with': 'XMLHttpRequest',
                'x-ig-app-id': '936619743392459',
                'x-asbd-id': '198387',
                'x-ig-www-claim': '0'
            }
        }
    );
    handleInstagramApiError(response);
    const data = await response.json();
    return data?.data?.user?.id;
}

/**
 * Unfollow one account.
 *
 * @param {string} username Used only for the fallback id lookup and for messages.
 * @param {string} [userId] The id, when the caller already has it — which it does everywhere the
 *        table is involved. Passing it skips a web_profile_info call per account: that endpoint is
 *        deprecated, throttles quickly, and on a bulk run it was being hit once per unfollow.
 */
/**
 * Post an unfollow to one of Instagram's endpoints.
 *
 * A refusal arrives as 200 carrying an HTML page rather than as an error status, so the body is
 * what decides, not the code or the content type.
 *
 * @returns {Promise<boolean|null>} true/false on a real answer, null when the endpoint refused.
 */
/**
 * The request never reached Instagram, or Instagram could not answer it.
 *
 * Kept apart from `null` — which means Instagram answered and declined — because the two must not
 * lead to the same conclusion. A dropped wifi packet reported as a refusal is how a working account
 * gets told it is blocked.
 */
const TRANSPORT_FAILED = Symbol('transport-failed');

/**
 * @returns {Promise<true|false|null|typeof TRANSPORT_FAILED>}
 *   true/false — Instagram answered; null — it answered with the refusal signature (200 carrying
 *   HTML); TRANSPORT_FAILED — no usable answer at all.
 */
async function postUnfollow(url, headers, body = '') {
    let response;
    try {
        response = await fetch(url, { method: 'POST', credentials: 'include', headers, body });
    } catch (error) {
        return TRANSPORT_FAILED;          // offline, DNS, aborted — not a decision by Instagram
    }
    if (response.status === 401 || response.status === 403) {
        const err = new Error(getMessage('errorSessionExpired'));
        err.code = 'SESSION_EXPIRED';
        throw err;
    }
    // A 5xx is Instagram having trouble, never a refusal aimed at this account.
    if (response.status >= 500) return TRANSPORT_FAILED;

    const text = await response.text();
    try {
        return JSON.parse(text).status === 'ok';
    } catch (error) {
        return null;                      // 200 with a non-JSON body: the refusal signature
    }
}

async function unfollowUser(username, userId, options = {}) {
    try {
        const targetId = userId || await resolveUserId(username);
        if (!targetId) throw new Error(getMessage('failedToUnfollow') || 'Could not resolve account');

        const csrftoken = await getCsrfTokenOnce();

        // Two endpoints, tried in order, because they are not equally alive.
        //
        // On some sessions `api/v1/friendships/destroy/` answers 200 with an HTML login page from
        // the very first request, while `/web/friendships/…/unfollow/` accepts request after
        // request from the same account at the same moment. That is not a rate limit being
        // enforced — a limit that one URL applies and two others ignore is a dead endpoint, not a
        // policy. So the working one leads and the other stays as a fallback.
        //
        // Pacing and backoff are unchanged: if both refuse, the run stops and says so.
        let ok = await postUnfollow(
            `https://www.instagram.com/web/friendships/${targetId}/unfollow/`,
            { 'x-csrftoken': csrftoken, 'x-requested-with': 'XMLHttpRequest' }
        );

        if (ok === null || ok === TRANSPORT_FAILED) {
            let dtsg = '';
            if (window.IgSession && typeof window.IgSession.getFbDtsg === 'function') {
                try {
                    const d = await window.IgSession.getFbDtsg();
                    dtsg = (d && d.dtsg) || '';
                } catch (e) {}
            }
            const bodyParams = new URLSearchParams({
                container_module: 'profile',
                user_id: String(targetId)
            });
            if (dtsg) {
                bodyParams.set('fb_dtsg', dtsg);
                if (window.IgSession && typeof window.IgSession.getJazoest === 'function') {
                    bodyParams.set('jazoest', window.IgSession.getJazoest(dtsg));
                }
            }

            ok = await postUnfollow(
                `https://www.instagram.com/api/v1/friendships/destroy/${targetId}/`,
                {
                    'accept': '*/*',
                    'content-type': 'application/x-www-form-urlencoded',
                    'x-asbd-id': '198387',
                    'x-csrftoken': csrftoken,
                    'x-ig-app-id': '936619743392459',
                    'x-ig-www-claim': '0',
                    'x-requested-with': 'XMLHttpRequest'
                },
                bodyParams.toString()
            );
        }

        // Neither endpoint could be reached. That is a connection problem, not a decision about
        // this account, and it must not be reported as one — the queue keeps the account and the
        // run backs off exactly as it would for a refusal.
        if (ok === TRANSPORT_FAILED) {
            const err = new Error(getMessage('errorNetwork') || 'Could not reach Instagram — check your connection.');
            err.code = 'NETWORK';
            throw err;
        }

        if (ok === null) {
            cachedCsrfToken = null;          // it may simply have gone stale
            const err = new Error(getMessage('errorRateLimit') || 'Instagram paused us — please wait');
            err.code = 'RATE_LIMIT';
            throw err;
        }

        // Counted only on confirmed success, so a blocked or failed request never eats the quota.
        // The write-path probe is a no-op health check and is the one caller that does not count.
        if (options.countQuota !== false) {
            await recordUnfollowUsed(currentUserId);
        }

        return ok;
    } catch (error) {
        console.error('Error unfollowing user:', error);
        throw error; // Hatayı yukarı fırlat
    }
}

// Event listener'ı güncelle
function setupUnfollowListeners() {
    const unfollowButtons = document.querySelectorAll('.unfollow-btn');

    unfollowButtons.forEach(button => {
        const clone = button.cloneNode(true);
        button.replaceWith(clone);

        clone.addEventListener('click', async function(e) {
            e.preventDefault();
            const username = this.dataset.username;
            const targetUserId = this.dataset.userid;
            const isMutualFollower = this.dataset.following === 'true';
            const row = this.closest('tr');

            if (currentWhitelistSet.has(username)) {
                showToast(`@${username} is protected in your whitelist.`, 'info');
                return;
            }

            // Extra safety confirmation before manually unfollowing someone who follows back
            if (isMutualFollower) {
                const proceed = await showCustomModal({
                    icon: 'warning',
                    title: `@${username} follows you back`,
                    message: `This user is currently following you. Are you sure you still want to unfollow @${username}?`,
                    confirmText: getMessage('yesUnfollow') || 'Yes, Unfollow',
                    cancelText: getMessage('cancel') || 'Cancel',
                    danger: true
                });
                if (!proceed) return;
            }

            try {
                this.disabled = true;
                this.textContent = getMessage('unfollowing');

                const allowance = await getDailyUnfollowAllowance(currentUserId);
                if (allowance && !allowance.isPremium && allowance.remaining <= 0) {
                    this.textContent = getMessage('unfollow');
                    this.disabled = false;
                    showToast(
                        getMessage('freeUnfollowLimitReached', [String(allowance.total)])
                            || 'Daily unfollow limit reached',
                        'error'
                    );
                    return;
                }

                // If row looked like a non-follower, double-check live relationship so stale state never removes a new follower
                if (!isMutualFollower && window.UnfollowBridge && typeof window.UnfollowBridge.checkFriendshipStatus === 'function') {
                    const liveRel = await window.UnfollowBridge.checkFriendshipStatus(targetUserId);
                    if (liveRel && liveRel.ok && liveRel.followedBy === true) {
                        markUserAsFollowingBackInMemory(targetUserId, username, row, this);
                        const stillUnfollow = await showCustomModal({
                            icon: 'info',
                            title: `@${username} actually follows you back!`,
                            message: `Live check confirmed @${username} is following you. We updated their badge to "Following You" and paused the unfollow. Unfollow anyway?`,
                            confirmText: 'Unfollow anyway',
                            cancelText: 'Keep following',
                            danger: true
                        });
                        if (!stillUnfollow) return;
                        this.disabled = true;
                        this.textContent = getMessage('unfollowing');
                    }
                }

                const success = await unfollowUser(username, targetUserId);

                if (success) {
                    this.innerHTML = `<span class="success-icon">✓</span> ${getMessage('unfollowedSuccess')}`;
                    this.classList.add('unfollowed');
                    if (row) row.classList.add('unfollowed-row');

                    const markUnfollowed = (u) => {
                        if (u && u.node && (u.node.username === username || String(u.node.id) === String(targetUserId))) {
                            u._unfollowed = true;
                        }
                    };
                    allDisplayData.forEach(markUnfollowed);
                    allFollowingFull.forEach(markUnfollowed);

                    if (followingCount > 0) followingCount--;
                    if (!isMutualFollower && nonFollowersCount > 0) nonFollowersCount--;
                    updateStats();
                    updateFilterChipCounts();

                    if (currentUserId) {
                        removeUserFromCache(currentUserId, username);
                    }
                } else {
                    this.textContent = getMessage('unfollow');
                    this.disabled = false;
                    showToast(getMessage('failedToUnfollow'), 'error');
                }
            } catch (error) {
                console.error('Error:', error);

                if (error.code === 'RATE_LIMIT') {
                    // A countdown on the button said "15S" and nothing else, which explains
                    // nothing. The same panel the bulk run uses says what happened and what still
                    // works, so a single failed click gets the same honest answer.
                    this.textContent = getMessage('unfollow');
                    this.disabled = false;
                    // One refusal is enough to know the path is shut: the pre-flight check for the
                    // next bulk run can then answer immediately instead of probing again. Stamped,
                    // so it expires like any other blocked verdict rather than sticking.
                    rememberWriteProbe('blocked');
                    await warnWritePathBlocked();
                    return;
                }

                this.textContent = getMessage('unfollow');
                this.disabled = false;
                showToast(error.message || getMessage('errorOccurred'), 'error');
            }
        });
    });
}

function markUserAsFollowingBackInMemory(userIdStr, username, row, btnEl) {
    const idNorm = userIdStr != null ? String(userIdStr) : '';
    const unameNorm = (username || '').toLowerCase();

    const updateNode = (u) => {
        if (!u || !u.node) return;
        if ((idNorm && String(u.node.id) === idNorm) || (unameNorm && (u.node.username || '').toLowerCase() === unameNorm)) {
            u.node.follows_viewer = true;
        }
    };
    allDisplayData.forEach(updateNode);
    allFollowingFull.forEach(updateNode);

    const alreadyInFollowers = allFollowersList.some(f =>
        f?.node && ((idNorm && String(f.node.id) === idNorm) || (unameNorm && (f.node.username || '').toLowerCase() === unameNorm))
    );
    if (!alreadyInFollowers) {
        allFollowersList.push({ node: { id: idNorm, username: username || '' } });
    }

    if (row) {
        row.classList.remove('not-following-user', 'processing');
        row.classList.add('following-user');
        const badge = row.querySelector('.not-following-badge, .following-badge');
        if (badge) {
            badge.className = 'following-badge';
            badge.textContent = getMessage('followingYouBadge');
        }
    }
    if (btnEl) {
        btnEl.classList.remove('loading');
        btnEl.classList.add('mutual-unfollow-btn');
        btnEl.dataset.following = 'true';
        btnEl.textContent = getMessage('unfollow');
        btnEl.disabled = currentWhitelistSet.has(username);
    }

    if (nonFollowersCount > 0) {
        nonFollowersCount--;
        updateStats();
    }
    updateFilterChipCounts();

    if (currentUserId && allFollowingFull.length > 0 && isDataComplete()) {
        saveAnalysisCache(currentUserId, allFollowingFull, allFollowersList, realFollowersTotal).catch(() => {});
    }
}

// Whitelist button listeners
function setupWhitelistListeners() {
    document.querySelectorAll('.whitelist-btn').forEach(btn => {
        const clone = btn.cloneNode(true);
        btn.replaceWith(clone);

        clone.addEventListener('click', async function(e) {
            e.preventDefault();
            if (!currentUserId) return;
            const username = this.dataset.username;
            const row = this.closest('tr');
            const unfollowBtn = row?.querySelector('.unfollow-btn');
            const isActive = this.classList.contains('active');

            if (isActive) {
                await removeFromWhitelist(currentUserId, username);
                currentWhitelistSet.delete(username);
                this.classList.remove('active');
                this.querySelector('svg').setAttribute('fill', 'none');
                this.title = getMessage('addToWhitelist');
                if (row) row.classList.remove('whitelisted-row');
                if (unfollowBtn && !unfollowBtn.classList.contains('unfollowed')) {
                    unfollowBtn.disabled = false;
                }
                if (analyzerChipFilter === 'whitelisted') {
                    renderCurrentPage();
                    return;
                }
            } else {
                await addToWhitelist(currentUserId, username);
                currentWhitelistSet.add(username);
                this.classList.add('active');
                this.querySelector('svg').setAttribute('fill', 'currentColor');
                this.title = getMessage('removeFromWhitelist');
                if (row) row.classList.add('whitelisted-row');
                if (unfollowBtn) {
                    unfollowBtn.disabled = true;
                }
            }
            updateFilterChipCounts();
        });
    });
}

// SweetAlert2 Helper Functions
async function showCustomModal(options) {
    if (typeof Swal === 'undefined') {
        // Fallback to simple confirm if Swal is not loaded
        const confirmed = confirm(options.message || 'Confirm action?');
        return confirmed;
    }

    const swalOptions = {
        icon: options.icon || 'warning',
        title: options.title || 'Confirm Action',
        text: options.message || '',
        html: options.details ? `<p>${options.message || ''}</p>${options.details}` : options.message,
        showCancelButton: options.showCancel !== false,
        confirmButtonText: options.confirmText || getMessage('yesUnfollow') || 'Confirm',
        cancelButtonText: options.cancelText || getMessage('cancel') || 'Cancel',
        confirmButtonColor: options.danger ? '#ef4444' : '#ff4757',
        cancelButtonColor: '#6c757d',
        reverseButtons: true,
        customClass: {
            popup: 'swal-custom-popup',
            title: options.danger ? 'swal-custom-title-danger' : 'swal-custom-title',
            htmlContainer: 'swal-custom-html',
            confirmButton: 'swal-custom-confirm',
            cancelButton: 'swal-custom-cancel'
        }
    };

    const result = await Swal.fire(swalOptions);
    return result.isConfirmed;
}

function showToast(message, type = 'success') {
    // Minimalist custom toast
    const toast = document.createElement('div');
    toast.className = `custom-toast custom-toast-${type}`;
    toast.innerHTML = `
        <div class="custom-toast-content">
            <span class="custom-toast-message">${message}</span>
        </div>
    `;
    
    document.body.appendChild(toast);
    
    // Show animation
    setTimeout(() => {
        toast.classList.add('show');
    }, 10);
    
    // Auto remove after 2.5 seconds
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => {
            if (toast.parentNode) {
                toast.parentNode.removeChild(toast);
            }
        }, 300);
    }, 2500);
}

// Helper: build queue from global data
function buildUnfollowQueue(mode) {
    const followerIds = new Set(allFollowersList.map(f => f?.node?.id != null ? String(f.node.id) : null).filter(Boolean));
    const followerUsernames = new Set(allFollowersList.map(f => f?.node?.username ? f.node.username.toLowerCase() : null).filter(Boolean));
    return allDisplayData.filter(user => {
        if (currentWhitelistSet.has(user.node.username)) return false;
        if (user._unfollowed) return false;
        if (user._unfollowError) return false;
        if (user._unfollowSkippedForLimit) return false;
        if (mode === 'nonFollowers') {
            if (user?.node?.follows_viewer === true) return false;
            const uid = user?.node?.id != null ? String(user.node.id) : null;
            if (uid && followerIds.has(uid)) return false;
            const uname = user?.node?.username ? user.node.username.toLowerCase() : null;
            if (uname && followerUsernames.has(uname)) return false;
            return true;
        }
        return true;
    });
}

/**
 * Refuse a bulk run when the lists behind it are not known to be whole.
 *
 * "Doesn't follow back" is a difference between two lists. If the followers list came back short,
 * everyone missing from it looks like a non-follower — so a bulk run would unfollow people who do
 * follow back, and that cannot be undone. "Unfollow everyone" only reads the following list, so it
 * is held to that list alone.
 *
 * @param {'nonFollowers'|'everyone'} mode
 * @returns {Promise<boolean>} true when it is safe to proceed.
 */
async function ensureDataCompleteFor(mode) {
    const needed = mode === 'nonFollowers'
        ? [lastScanInfo.followers, lastScanInfo.following]
        : [lastScanInfo.following];

    if (needed.every((info) => info && info.complete)) return true;

    await showCustomModal({
        icon: 'warning',
        title: getMessage('incompleteDataTitle') || 'The list is incomplete',
        message: getMessage('incompleteDataMessage')
            || 'Instagram stopped sending data before the whole list arrived, so some accounts are '
             + 'missing. Acting on it now could unfollow people who do follow you back. '
             + 'Please run the analysis again first.',
        confirmText: getMessage('reAnalyze') || 'Re-analyze'
    });
    return false;
}

/**
 * Everything that has to be true before a bulk run is offered.
 *
 * The rule here is that a check may stop a run only when it is sure. The completeness guard is
 * sure — it is reading a flag we set ourselves — so it stops. The write probe is one request
 * against a service that is allowed to have a bad second, so it can only advise.
 *
 * Anything unexpected returns 'ok'. A pre-flight that fails in a way nobody predicted must not take
 * the feature down with it; the run itself checks the same things again, per account, and stops
 * with an honest message if they turn out to be true.
 *
 * @returns {Promise<'ok'|'blocked'|'stop'>}
 */
async function runPreflight(mode) {
    try {
        if (!await ensureDataCompleteFor(mode)) return 'stop';
        return await probeWritePath() === 'blocked' ? 'blocked' : 'ok';
    } catch (error) {
        console.error('[unfollow] on kontrol basarisiz:', error);
        if (error.code === 'SESSION_EXPIRED') {
            await showCustomModal({
                icon: 'error',
                title: getMessage('sessionExpiredTitle') || 'Your Instagram session has ended',
                message: getMessage('errorSessionExpired')
                    || 'Please open instagram.com, sign in again, and reload this page.',
                confirmText: getMessage('ok') || 'OK',
                showCancel: false
            });
            return 'stop';
        }
        return 'ok';
    }
}

/**
 * Hold the clicked button in a visible "checking" state while the pre-flight runs.
 *
 * Before anything is confirmed, a bulk run verifies the lists are whole and probes the write path
 * against Instagram. Both go to the network, so seconds pass between the click and the confirmation
 * modal. A button that looks untouched for that long reads as a dead click — the natural response
 * is to press it again, which is how one intended run becomes two.
 *
 * @param {HTMLElement} button the one that was clicked
 * @param {() => Promise<any>} work the pre-flight; its return value is passed straight back
 */
async function withPreflight(button, work) {
    const buttons = [
        document.getElementById('unfollowNonFollowers'),
        document.getElementById('unfollowEveryone')
    ];
    const original = button ? button.innerHTML : '';

    buttons.forEach((b) => { if (b) b.disabled = true; });
    if (button) {
        button.classList.add('btn-checking');
        button.innerHTML = '<div class="button-content"><span class="btn-spinner"></span>'
            + `<span class="button-text">${getMessage('checkingBeforeStart') || 'Checking…'}</span></div>`;
    }

    try {
        return await work();
    } finally {
        if (button) {
            button.classList.remove('btn-checking');
            button.innerHTML = original;
        }
        // A run that actually started disables these itself and owns them until it stops.
        if (!isUnfollowingActive) buttons.forEach((b) => { if (b) b.disabled = false; });
    }
}

// Must match the min/max/value on #waitingTime in analyzer.html.
const MIN_WAIT_SECONDS = 3;
const MAX_WAIT_SECONDS = 300;
const DEFAULT_WAIT_SECONDS = 120;

/**
 * The delay the user typed, or the default when the box cannot be read.
 *
 * `<input type="number">` reports an empty string for anything the browser will not parse — a
 * trailing space, a decimal comma, a stray character. The box can therefore read as blank while
 * still looking filled, and the old code answered that by refusing to start and telling the user to
 * enter a valid time, with a valid-looking time on screen in front of them. There is nothing they
 * could do with that message.
 *
 * An unreadable box now falls back to the shipped default instead of blocking the run. Nothing
 * starts unattended either way: the confirmation modal still stands between this and the first
 * unfollow, and it shows the delay that will actually be used.
 */
function readWaitingTime(input) {
    const seconds = parseInt(String(input.value || '').trim(), 10);
    if (isNaN(seconds)) {
        console.warn('[unfollow] bekleme suresi okunamadi, varsayilana donuldu:', JSON.stringify(input.value));
        input.value = String(DEFAULT_WAIT_SECONDS);
        return DEFAULT_WAIT_SECONDS;
    }
    return seconds;
}

/**
 * The delay stated on the confirmation modal.
 *
 * It is the last thing shown before the run starts, and it is the only place the fallback above
 * becomes visible — if the box was unreadable and the default was used, the user reads the real
 * number here and can still cancel.
 */
function waitDetailText(seconds) {
    return getMessage('unfollowWaitDetail', [String(seconds)])
        || `${seconds} seconds between each unfollow.`;
}

/** Tells the user the number they actually entered, rather than that "a" number is invalid. */
async function warnWaitingTimeOutOfRange(seconds) {
    await showCustomModal({
        icon: 'error',
        title: getMessage('invalidWaitingTimeTitle') || 'Invalid waiting time',
        message: getMessage('invalidWaitingTimeValue', [String(seconds), String(MIN_WAIT_SECONDS), String(MAX_WAIT_SECONDS)])
            || `${seconds} seconds is outside the allowed range. Please enter a value between ${MIN_WAIT_SECONDS} and ${MAX_WAIT_SECONDS} seconds.`,
        confirmText: getMessage('ok') || 'OK',
        showCancel: false
    });
}

// Enforce the free plan's daily unfollow cap on a bulk run before it is confirmed.
// Returns the (possibly reduced) queue, or null when the run must stop entirely.
// Premium members pass through unchanged. The skip flag is per-run: a later run on the same
// page (e.g. the next day, when the allowance has refilled) rebuilds the whole queue.
async function applyUnfollowAllowance(mode) {
    allDisplayData.forEach(user => { user._unfollowSkippedForLimit = false; });
    const queue = buildUnfollowQueue(mode);

    if (!currentUserId) return queue;
    const allowance = await getDailyUnfollowAllowance(currentUserId);
    if (!allowance || allowance.isPremium) return queue;

    if (allowance.remaining <= 0) {
        // If user hasn't claimed their review bonus yet, offer +100 bonus unfollows for leaving a review!
        const canClaimBonus = window.ReviewPrompt && !(await window.ReviewPrompt.isBonusClaimed());
        if (canClaimBonus) {
            const wantsBonus = await showCustomModal({
                icon: 'info',
                title: 'Daily Limit Reached — Unlock +100 Free!',
                message: 'You have reached today\'s ' + allowance.total + ' unfollows limit. Leave a quick 5-star review on the Chrome Web Store to immediately unlock +100 bonus unfollows!',
                confirmText: '⭐ Rate & Get +100 Free',
                cancelText: 'Upgrade to Premium',
                showCancel: true
            });
            if (wantsBonus) {
                await window.ReviewPrompt.claimBonus();
                showToast('🎉 +100 Bonus Unfollows added!', 'success');
            } else {
                openPremiumModal();
            }
            return null;
        }

        const wantsUpgrade = await showCustomModal({
            icon: 'info',
            title: 'Daily unfollow limit reached',
            message: getMessage('freeUnfollowLimitReached', [String(allowance.total)])
                || 'You can unfollow up to ' + allowance.total + ' users per day with the free plan. Upgrade to Premium for unlimited unfollowing.',
            confirmText: getMessage('upgradeToPremium') || 'Upgrade to Premium',
            cancelText: getMessage('ok') || 'OK',
            showCancel: true
        });
        if (wantsUpgrade) openPremiumModal();
        return null;
    }

    if (queue.length > allowance.remaining) {
        const capped = queue.slice(0, allowance.remaining);
        queue.slice(allowance.remaining).forEach(user => {
            user._unfollowSkippedForLimit = true;
        });
        await showCustomModal({
            icon: 'info',
            title: 'Daily unfollow limit reached',
            message: 'The free plan allows ' + allowance.total + ' unfollows per day. This run will '
                + 'unfollow ' + allowance.remaining + ' of ' + queue.length + ' selected accounts — '
                + 'the rest stay on the list and can be unfollowed tomorrow or with Premium.',
            confirmText: getMessage('ok') || 'OK',
            showCancel: false
        });
        return capped;
    }

    return queue;
}

async function startUnfollowNonFollowers() {
    // Both checks go to the network, so they run behind the button's checking state.
    const preflight = await withPreflight(document.getElementById('unfollowNonFollowers'), async () => {
        // Checked before anything is queued, so a held-back account is told up front rather than
        // after a run that goes nowhere.
        return await runPreflight('nonFollowers');
    });
    if (preflight === 'stop') return;
    if (preflight === 'blocked' && !await warnWritePathBlocked()) return;

    // A fresh run starts with a fresh allowance: the escalation is per-run, not permanent.
    writeBackoffStep = 0;
    unfollowMode = 'nonFollowers';
    const nonFollowersBtn = document.getElementById('unfollowNonFollowers');
    const everyoneBtn = document.getElementById('unfollowEveryone');
    const stopButton = document.getElementById('stopUnfollow');
    const waitingTimeInput = document.getElementById('waitingTime');
    const queue = await applyUnfollowAllowance('nonFollowers');
    if (queue === null) return;

    const waitingTime = readWaitingTime(waitingTimeInput);
    if (waitingTime < MIN_WAIT_SECONDS || waitingTime > MAX_WAIT_SECONDS) {
        await warnWaitingTimeOutOfRange(waitingTime);
        return;
    }

    if (queue.length === 0) {
        await showCustomModal({
            icon: 'info',
            title: getMessage('noNonFollowers') || 'No Non-Followers',
            message: getMessage('noNonFollowersToUnfollow') || 'No non-followers to unfollow.',
            confirmText: getMessage('ok') || 'OK',
            showCancel: false
        });
        return;
    }

    const confirmed = await showCustomModal({
        icon: 'warning',
        title: getMessage('confirmUnfollowNonFollowers') || 'Confirm Action',
        message: getMessage('confirmUnfollowNonFollowersText') || 'Are you sure you want to unfollow all non-followers?',
        details: `<p style="color: #6c757d; font-size: 13px; margin: 8px 0 0 0;"><strong>${queue.length}</strong> ${getMessage('usersWillBeUnfollowed') || 'users will be unfollowed.'}</p>
            <p style="color: #6c757d; font-size: 12px; margin: 4px 0 0 0;">${waitDetailText(waitingTime)}</p>`,
        confirmText: getMessage('yesUnfollow') || 'Yes, Unfollow',
        cancelText: getMessage('cancel') || 'Cancel'
    });

    if (!confirmed) {
        return;
    }

    unfollowDelay = waitingTime * 1000; // Milisaniyeye çevir
    
    // Başlangıçta pending sayısını güncelle
    // İstatistikler zaten initializeFollowingList'te güncelleniyor

    // İşlemi başlat
    isUnfollowingActive = true;
    isProcessingQueue = false;
    nonFollowersBtn.disabled = true;
    everyoneBtn.disabled = true;
    stopButton.disabled = false;
    waitingTimeInput.disabled = true;

    // Başarı mesajı
    showToast(getMessage('unfollowProcessStarted') || 'Unfollow process has started.', 'success');

    processUnfollowQueue();
}

async function startUnfollowEveryone() {
    const preflight = await withPreflight(document.getElementById('unfollowEveryone'), async () => {
        return await runPreflight('everyone');
    });
    if (preflight === 'stop') return;
    if (preflight === 'blocked' && !await warnWritePathBlocked()) return;

    writeBackoffStep = 0;
    unfollowMode = 'everyone';
    const nonFollowersBtn = document.getElementById('unfollowNonFollowers');
    const everyoneBtn = document.getElementById('unfollowEveryone');
    const stopButton = document.getElementById('stopUnfollow');
    const waitingTimeInput = document.getElementById('waitingTime');
    const queue = await applyUnfollowAllowance('everyone');
    if (queue === null) return;

    const waitingTime = readWaitingTime(waitingTimeInput);
    if (waitingTime < MIN_WAIT_SECONDS || waitingTime > MAX_WAIT_SECONDS) {
        await warnWaitingTimeOutOfRange(waitingTime);
        return;
    }

    if (queue.length === 0) {
        await showCustomModal({
            icon: 'info',
            title: getMessage('noUsers') || 'No Users',
            message: getMessage('noUsersToUnfollow') || 'No users to unfollow.',
            confirmText: getMessage('ok') || 'OK',
            showCancel: false
        });
        return;
    }

    const confirmed = await showCustomModal({
        icon: 'error',
        title: getMessage('confirmUnfollowEveryone') || '⚠️ Warning!',
        message: getMessage('confirmUnfollowEveryoneText') || 'Are you sure you want to unfollow EVERYONE?',
        details: `
            <p style="color: #ef4444; font-size: 13px; margin: 8px 0; font-weight: 600;">
                <strong>${queue.length}</strong> ${getMessage('allUsersWillBeUnfollowed') || 'users will be unfollowed.'}
            </p>
            <p style="color: #6c757d; font-size: 12px; margin: 0;">
                ${getMessage('thisActionCannotBeUndone') || '⚠️ This action cannot be undone!'}
            </p>
            <p style="color: #6c757d; font-size: 12px; margin: 4px 0 0 0;">${waitDetailText(waitingTime)}</p>
        `,
        confirmText: getMessage('yesUnfollowAll') || 'Yes, Unfollow All',
        cancelText: getMessage('cancel') || 'Cancel',
        danger: true
    });

    if (!confirmed) {
        return;
    }

    unfollowDelay = waitingTime * 1000; // Milisaniyeye çevir
    
    // Başlangıçta pending sayısını güncelle
    // İstatistikler zaten initializeFollowingList'te güncelleniyor

    // İşlemi başlat
    isUnfollowingActive = true;
    isProcessingQueue = false;
    nonFollowersBtn.disabled = true;
    everyoneBtn.disabled = true;
    stopButton.disabled = false;
    waitingTimeInput.disabled = true;

    // Başarı mesajı
    showToast(getMessage('unfollowProcessStarted') || 'Unfollow process has started.', 'success');

    processUnfollowQueue();
}

async function processUnfollowQueue() {
    if (!isUnfollowingActive || isProcessingQueue) return;

    isProcessingQueue = true;

    // Build queue from global data (not DOM)
    const queue = buildUnfollowQueue(unfollowMode);

    for (let i = 0; i < queue.length; i++) {
        if (!isUnfollowingActive) break;

        const user = queue[i];
        const username = user.node.username;

        // Re-check whitelist & follower state live before acting (user may have whitelisted mid-run)
        if (currentWhitelistSet.has(username) || user._unfollowed) {
            continue;
        }
        if (unfollowMode === 'nonFollowers' && isUserFollowingMe(user, allFollowersList)) {
            continue;
        }

        // Navigate to the page containing this user (filter-aware)
        const filtered = getFilteredData();
        const filteredIndex = filtered.indexOf(user);
        const targetPage = filteredIndex >= 0 ? Math.floor(filteredIndex / PAGE_SIZE) + 1 : currentPage;
        if (targetPage !== currentPage) {
            currentPage = targetPage;
            renderCurrentPage();
            await new Promise(r => setTimeout(r, 300));
        }

        // Find row in DOM - retry once if not found after page render
        let row = document.querySelector(`tr[data-username="${CSS.escape(username)}"]`);
        if (!row) {
            await new Promise(r => setTimeout(r, 200));
            row = document.querySelector(`tr[data-username="${CSS.escape(username)}"]`);
        }
        const unfollowBtn = row?.querySelector('.unfollow-btn');

        try {
            // LIVE PRE-UNFOLLOW CIRCUIT BREAKER (before waiting, so skipped mutuals cost 0 wait time!):
            // Query Instagram's single-user friendship endpoint to guarantee we NEVER unfollow someone
            // who follows the viewer back (even if they followed back after the scan ran!).
            if (unfollowMode === 'nonFollowers' && window.UnfollowBridge && typeof window.UnfollowBridge.checkFriendshipStatus === 'function') {
                const liveRel = await window.UnfollowBridge.checkFriendshipStatus(user.node.id);
                if (liveRel && liveRel.ok && liveRel.followedBy === true) {
                    markUserAsFollowingBackInMemory(user.node.id, username, row, unfollowBtn);
                    showToast(`Protected @${username} — follows you back!`, 'info');
                    if (analyzerChipFilter === 'notFollowing') {
                        renderCurrentPage();
                    }
                    continue;
                }
            }

            // Wait before each unfollow - timestamp-based (survives background tab throttling)
            const waitSeconds = unfollowDelay / 1000;
            if (waitSeconds > 0) {
                await new Promise((resolve) => {
                    const endTime = Date.now() + (waitSeconds * 1000);
                    unfollowEndTime = endTime;

                    const checkRemaining = () => {
                        if (!isUnfollowingActive) { updateTimerDisplay(0); resolve(); return; }
                        const remaining = Math.max(0, Math.ceil((endTime - Date.now()) / 1000));
                        updateTimerDisplay(remaining);
                        if (remaining <= 0) { resolve(); return; }
                        unfollowTimerId = setTimeout(checkRemaining, 1000);
                    };
                    checkRemaining();
                });
                unfollowEndTime = 0;
                if (unfollowTimerId) { clearTimeout(unfollowTimerId); unfollowTimerId = null; }
            }

            if (!isUnfollowingActive) break;
            if (currentWhitelistSet.has(username)) continue;

            // Second live check after a long wait (>30s), in case they followed back during the countdown!
            if (unfollowMode === 'nonFollowers' && waitSeconds >= 30 && window.UnfollowBridge && typeof window.UnfollowBridge.checkFriendshipStatus === 'function') {
                const postWaitRel = await window.UnfollowBridge.checkFriendshipStatus(user.node.id);
                if (postWaitRel && postWaitRel.ok && postWaitRel.followedBy === true) {
                    markUserAsFollowingBackInMemory(user.node.id, username, row, unfollowBtn);
                    showToast(`Protected @${username} — follows you back!`, 'info');
                    continue;
                }
            }

            // Refresh DOM reference in case user changed page/filter during countdown
            row = document.querySelector(`tr[data-username="${CSS.escape(username)}"]`);
            const activeUnfollowBtn = row?.querySelector('.unfollow-btn');

            if (row) {
                row.scrollIntoView({ behavior: 'smooth', block: 'center' });
                row.classList.add('processing');
            }
            if (activeUnfollowBtn) {
                activeUnfollowBtn.disabled = true;
                activeUnfollowBtn.classList.add('loading');
                activeUnfollowBtn.innerHTML = `<span class="loading-spinner-small"></span>`;
            }

            const wasFollowingMe = isUserFollowingMe(user, allFollowersList);
            const success = await unfollowUser(username, user.node.id);

            if (activeUnfollowBtn) activeUnfollowBtn.classList.remove('loading');

            if (success) {
                user._unfollowed = true;
                allFollowingFull.forEach(u => {
                    if (u && u.node && String(u.node.id) === String(user.node.id)) u._unfollowed = true;
                });

                if (row) {
                    row.classList.remove('processing');
                    row.classList.add('unfollowed-row');
                }
                if (activeUnfollowBtn) {
                    activeUnfollowBtn.innerHTML = `<span class="success-icon">✓</span> ${getMessage('unfollowedSuccess')}`;
                    activeUnfollowBtn.disabled = true;
                    activeUnfollowBtn.classList.add('unfollowed');
                }

                if (currentUserId) {
                    removeUserFromCache(currentUserId, username);
                }
                if (followingCount > 0) followingCount--;
                if (!wasFollowingMe && nonFollowersCount > 0) nonFollowersCount--;
                updateStats();
                updateFilterChipCounts();
            } else {
                if (row) row.classList.remove('processing');
                if (activeUnfollowBtn) {
                    activeUnfollowBtn.textContent = getMessage('unfollowFailed');
                    activeUnfollowBtn.disabled = false;
                }
            }

            // Check remaining
            const remaining = buildUnfollowQueue(unfollowMode);
            if (remaining.length === 0) clearCountdownTimer();

        } catch (error) {
            console.error('Unfollow error:', error);
            if (row) row.classList.remove('processing');

            // A refusal and a connection failure get the same treatment for the same reason: the
            // account was not unfollowed and nothing about it is wrong. What differs is only what
            // the user is told. Anything below this line marks the account and drops it from the
            // queue for good, which a dropped wifi packet must never cause.
            if (error.code === 'RATE_LIMIT' || error.code === 'NETWORK') {
                const offline = error.code === 'NETWORK';
                const notice = offline
                    ? (getMessage('errorNetwork') || 'Could not reach Instagram — check your connection.')
                    : getMessage('errorUnfollowRateLimit');

                // Deliberately not marked as _unfollowError: nothing is wrong with this account and
                // it was never unfollowed. Marking it would drop it from the queue permanently, so
                // a run that hit a limit would quietly skip everyone it paused on.
                if (row) row.classList.remove('processing');

                const waitMs = WRITE_BACKOFF_MS[writeBackoffStep]
                    || WRITE_BACKOFF_MS[WRITE_BACKOFF_MS.length - 1];

                // Out of patience: stop cleanly rather than keep pushing at a closed door.
                if (writeBackoffStep >= WRITE_BACKOFF_MS.length) {
                    showToast(notice, 'error');
                    stopUnfollowProcess();
                    break;
                }
                writeBackoffStep++;

                // Everything after this waits longer too. Coming back at the same pace that just
                // got refused only earns another refusal. A connection failure is not the account's
                // fault, so it does not drag the pace down for the rest of the run.
                if (!offline) unfollowDelay = Math.min(unfollowDelay * 1.5, 5 * 60 * 1000);

                showToast(notice, 'error');
                showWriteBackoffCountdown(Math.round(waitMs / 1000));

                retryTimeout = setTimeout(() => {
                    retryTimeout = null;
                    if (isUnfollowingActive) processUnfollowQueue();
                }, waitMs);
                break;
            }

            user._unfollowError = true;
            if (error.code === 'SESSION_EXPIRED') {
                showToast(getMessage('errorSessionExpired'), 'error');
                stopUnfollowProcess();
                break;
            }
            showToast(error.message || getMessage('errorOccurred'), 'error');
        }
    }

    isProcessingQueue = false;
}

function stopUnfollowProcess() {
    if (writeCountdownTimer) { clearInterval(writeCountdownTimer); writeCountdownTimer = null; }
    const cd = document.getElementById("countdownDisplay");
    if (cd) cd.style.display = "none";
    isUnfollowingActive = false;
    isProcessingQueue = false;
    if (retryTimeout) {
        clearTimeout(retryTimeout);
        retryTimeout = null;
    }
    
    // Timer'ları durdur
    clearCountdownTimer();
    unfollowEndTime = 0;
    if (unfollowTimerId) { clearTimeout(unfollowTimerId); unfollowTimerId = null; }

    const nonFollowersBtn = document.getElementById('unfollowNonFollowers');
    const everyoneBtn = document.getElementById('unfollowEveryone');
    const stopButton = document.getElementById('stopUnfollow');
    const waitingTimeInput = document.getElementById('waitingTime');
    
    if (nonFollowersBtn) nonFollowersBtn.disabled = false;
    if (everyoneBtn) everyoneBtn.disabled = false;
    if (stopButton) stopButton.disabled = true;
    if (waitingTimeInput) waitingTimeInput.disabled = false;
    
    updateTimerDisplay(0);
    updateStats();
}

// Geri sayım timer'ını başlat
function startCountdownTimer(seconds) {
    clearCountdownTimer(); // Önceki timer'ı temizle
    currentCountdown = Math.floor(seconds);
    
    // İlk güncelleme
    updateTimerDisplay(currentCountdown);
    
    // Her saniye güncelle - timer 0'a ulaşınca hemen durdur
    countdownTimer = setInterval(() => {
        currentCountdown--;
        
        if (currentCountdown <= 0) {
            clearCountdownTimer();
            updateTimerDisplay(0);
        } else {
            updateTimerDisplay(currentCountdown);
        }
    }, 1000);
}

// Geri sayım timer'ını durdur
function clearCountdownTimer() {
    if (countdownTimer) {
        clearInterval(countdownTimer);
        countdownTimer = null;
    }
    currentCountdown = 0;
}

function updateTimerDisplay(seconds) {
    const countdownDisplay = document.getElementById('countdownDisplay');
    const countdownText = document.getElementById('countdownText');
    const nonFollowersBtn = document.getElementById('unfollowNonFollowers');
    const everyoneBtn = document.getElementById('unfollowEveryone');
    
    // Eğer işlem aktifse timer göster
    if (isUnfollowingActive) {
        if (seconds > 0) {
            // Countdown display'i göster
            if (countdownDisplay) {
                countdownDisplay.style.display = 'flex';
            }
            if (countdownText) {
                const secondsInt = Math.floor(seconds);
                // Placeholder'ı manuel olarak değiştir
                let message = getMessage('nextInSeconds') || 'Next in $SECONDS$s';
                
                // Önce $SECONDS$ formatını dene (messages.json'da bu format kullanılıyor)
                if (message.includes('$SECONDS$')) {
                    message = message.replace(/\$SECONDS\$/g, secondsInt.toString());
                } 
                // Sonra $1 formatını dene (Chrome i18n standardı)
                else if (message.includes('$1')) {
                    message = message.replace(/\$1/g, secondsInt.toString());
                }
                // Hiçbiri yoksa direkt ekle
                else {
                    message = `Next: ${secondsInt}s`;
                }
                
                countdownText.textContent = message;
            }
        } else {
            // Timer 0'a ulaştığında display'i gizle ama butonları disabled tut
            if (countdownDisplay) {
                countdownDisplay.style.display = 'none';
            }
        }
        
        // İşlem aktifken butonları her zaman disabled tut
        if (nonFollowersBtn) nonFollowersBtn.disabled = true;
        if (everyoneBtn) everyoneBtn.disabled = true;
    } else {
        // İşlem durdurulduğunda countdown display'i gizle ve butonları aktif et
        if (countdownDisplay) {
            countdownDisplay.style.display = 'none';
        }
        if (nonFollowersBtn) {
            nonFollowersBtn.innerHTML = `
                <div class="button-content">
                    <svg class="button-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                        <circle cx="8.5" cy="7" r="4"></circle>
                        <line x1="18" y1="8" x2="23" y2="8"></line>
                        <line x1="20.5" y1="5.5" x2="20.5" y2="10.5"></line>
                    </svg>
                    <span class="button-text">${getMessage('unfollowNonFollowers')}</span>
                </div>
            `;
            nonFollowersBtn.disabled = false;
        }
        if (everyoneBtn) {
            everyoneBtn.innerHTML = `
                <div class="button-content">
                    <svg class="button-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                        <circle cx="9" cy="7" r="4"></circle>
                        <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
                        <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
                        <line x1="18" y1="10" x2="23" y2="10"></line>
                        <line x1="20.5" y1="7.5" x2="20.5" y2="12.5"></line>
                    </svg>
                    <span class="button-text">${getMessage('unfollowEveryone')}</span>
                </div>
            `;
            everyoneBtn.disabled = false;
        }
    }
}


// Initialize when page loads
document.addEventListener('DOMContentLoaded', () => initializeFollowingList(false));

function updateStats() {
    // Update overview stat cards with user's locale formatting
    const followersElement = document.getElementById('followersCount');
    const followingElement = document.getElementById('followingCount');
    const nonFollowersElement = document.getElementById('nonFollowersCount');

    if (followersElement) {
        followersElement.textContent = followersCount.toLocaleString();
    }
    if (followingElement) {
        followingElement.textContent = followingCount.toLocaleString();
    }
    if (nonFollowersElement) {
        nonFollowersElement.textContent = nonFollowersCount.toLocaleString();
    }
}

// Kullanıcı bilgilerini al ve göster
async function displayUserInfo() {
    try {
        // Session bootstrap (ig-session.js): /data/shared_data/ is gone (404); the viewer now
        // comes off the Instagram homepage, with the avatar read from users/{id}/info/ when the
        // homepage did not carry one.
        const session = await window.IgSession.fetchSession();
        if (session.status !== 'ok' || !session.username) {
            const userInfo = document.querySelector('.user-info');
            if (userInfo) {
                userInfo.style.display = 'none';
            }
            return;
        }
        const user = {
            username: session.username,
            email: '',
            profile_pic_url: session.profilePicUrl || ''
        };
        if (!user.profile_pic_url) {
            try {
                const res = await fetch(`https://www.instagram.com/api/v1/users/${encodeURIComponent(session.id)}/info/`, {
                    credentials: 'include',
                    headers: {
                        'Accept': '*/*',
                        'Accept-Language': 'en-US,en;q=0.9',
                        'X-Asbd-Id': '198387',
                        'X-Ig-App-Id': '936619743392459',
                        'X-Instagram-AJAX': '1',
                        'X-CSRFToken': session.csrfToken || '',
                        'X-Requested-With': 'XMLHttpRequest'
                    }
                });
                if (res.ok) {
                    const data = await res.json();
                    if (data?.user?.profile_pic_url) user.profile_pic_url = data.user.profile_pic_url;
                }
            } catch (e) { /* avatar is cosmetic; keep the default */ }
        }

        if (user) {
            const userAvatar = document.getElementById('userAvatar');
            const userInfo = document.querySelector('.user-info');
            const userName = document.getElementById('userName');
            const userEmail = document.getElementById('userEmail');
            const userPlanPill = document.getElementById('userPlanPill');
            const headerUpgradeBtn = document.getElementById('headerUpgradeBtn');

            if (userInfo) {
                userInfo.style.display = 'flex';
                userInfo.classList.add('loaded');
            }

            if (userAvatar) {
                userAvatar.onerror = () => {
                    userAvatar.src = 'img/128.png';
                    userAvatar.classList.add('loaded');
                };
                if (user.profile_pic_url) {
                    userAvatar.src = user.profile_pic_url;
                    if (window.loadAvatar) loadAvatar(userAvatar, user.profile_pic_url);
                    userAvatar.onload = () => userAvatar.classList.add('loaded');
                } else {
                    userAvatar.src = 'img/128.png';
                    userAvatar.classList.add('loaded');
                }
            }

            if (userName) {
                userName.textContent = user.username;
            }

            if (userEmail) {
                userEmail.textContent = user.email || '@' + user.username;
            }

            if (typeof getPremiumMembership === 'function') {
                getPremiumMembership().then((membership) => {
                    const isPremium = membership && (membership.turu === 'premium' || membership.turu === 'Premium');
                    if (userPlanPill) {
                        userPlanPill.textContent = isPremium ? 'PRO' : 'FREE';
                        userPlanPill.className = 'user-plan-pill ' + (isPremium ? 'pro' : 'free');
                    }
                    if (headerUpgradeBtn && isPremium) {
                        headerUpgradeBtn.style.display = 'none';
                    }
                }).catch(() => {});
            }
        } else {
            const userInfo = document.querySelector('.user-info');
            if (userInfo) {
                userInfo.style.display = 'none';
            }
        }
    } catch (error) {
        console.error('Error fetching user info:', error);
    }
}

// Sayfa yüklendiğinde çağır
document.addEventListener('DOMContentLoaded', displayUserInfo);

// Premium Modal Functions
// Premium modal (pricing, plan choice, checkout) now lives in premium.js, shared with bot-scan.
