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

// Cache functions
async function getAnalysisCache(userId) {
    const data = await chrome.storage.local.get([`analysisCache_${userId}`]);
    const cache = data[`analysisCache_${userId}`] || null;
    // Anything written before the completeness flag could be a truncated list saved as if whole.
    // Dropping it costs one re-scan; trusting it can cost the user real followers.
    if (cache && cache.complete !== true) return null;
    return cache;
}

async function saveAnalysisCache(userId, followingList, followersList, followersTotal) {
    // Slim data before saving to avoid quota issues (50K users = ~18MB vs ~70MB raw)
    const slimFollowing = followingList.map(u => ({
        node: {
            id: u.node.id,
            username: u.node.username,
            full_name: u.node.full_name || '',
            profile_pic_url: u.node.profile_pic_url,
            is_verified: u.node.is_verified || false
        }
    }));
    const slimFollowers = followersList.map(u => ({
        node: { id: u.node.id }
    }));
    await chrome.storage.local.set({
        [`analysisCache_${userId}`]: {
            followingList: slimFollowing,
            followersList: slimFollowers,
            // Only set on the follows_viewer path, where followersList holds just the followers
            // who are also followed back — so its length is not the follower count and the number
            // shown on screen has to come from Instagram's own figure instead.
            followersTotal: followersTotal ?? null,
            timestamp: Date.now(),
            // Marks a pair that was read end to end. Entries written before this flag existed may
            // have been truncated by the old reader, so they are discarded rather than trusted.
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

// Sekme geri geldiğinde timer'ı hemen güncelle (Chrome throttling fix)
document.addEventListener('visibilitychange', () => {
    if (!document.hidden && isUnfollowingActive && unfollowEndTime > 0) {
        const remaining = Math.max(0, Math.ceil((unfollowEndTime - Date.now()) / 1000));
        updateTimerDisplay(remaining);
    }
});

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

    // Premium upgrade butonu için event listener
    const upgradeBtn = document.getElementById('upgradeToPremiumBtn');
    if (upgradeBtn) {
        upgradeBtn.addEventListener('click', function() {
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
            const planType = e.target.getAttribute('data-plan') || 'monthly';
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
        // Without credentials this endpoint still answers 200 with JSON, but as a logged-out
        // visitor — `config.viewer` comes back empty and the caller concludes the user is signed out.
        const response = await fetch('https://www.instagram.com/data/shared_data/', {
            credentials: 'include'
        });
        handleInstagramApiError(response);
        const data = await response.json();
        const viewer = data.config.viewer;
        sessionUsername = viewer?.username || '';
        logScanDiag({
            stage: 'session',
            msg: viewer ? 'Instagram session found' : 'NO Instagram session in this Chrome browser',
            detail: viewer
                ? '@' + sessionUsername + ' (id ' + viewer.id + ') — the scan reads this account'
                : 'Open instagram.com in this Chrome browser and log in first'
        });
        return viewer?.id;
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

    console.log('[bridge] follows_viewer:', {
        count: result.users.length, requests: result.requests, reason: result.reason
    });
    return result;
}

async function getFollowingList(userId) {
    return readList(userId, 'following');
}

async function getFollowersList(userId) {
    return readList(userId, 'followers');
}

/**
 * Read one list through the bridge (v1 first, legacy graphql in reserve) and record how it ended.
 * Returns the same edge array shape the rest of this file has always consumed.
 */
async function readList(userId, type) {
    const { scanPeers, SCAN_REASON } = window.UnfollowBridge;
    const viewer = await getViewerOnce();
    const messageKey = type === 'following' ? 'dataLoadingFollowing' : 'dataLoadingFollowers';

    const expected = await getExpectedOnce(userId, type);

    /**
     * Draws the progress panel.
     *
     * v1 returns about 23 accounts per request, so a 10,000-follower list is several hundred
     * round trips. Without a count and a remaining estimate that reads as a hung spinner, which
     * is the single biggest reason a working scan gets abandoned half way.
     */
    setScanStage(type);
    const reportCount = (progress) => renderScanProgress(type, progress, expected);

    // Prefer to run the read inside an open Instagram tab: the requests then leave from
    // instagram.com instead of from this extension page, which is what the site's own calls look
    // like. If no tab is open, or it goes away mid-read, fall through and read from here — the
    // path this extension has always used.
    let result = null;
    const pageBridge = window.UnfollowPageBridge;
    if (pageBridge && await pageBridge.isPageAvailable()) {
        const attempt = await pageBridge.runScanInPage({ userId, listType: type, onProgress: reportCount });
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

function findNonFollowers(following, followers) {
    const followerIds = new Set(followers.map(f => f.node.id));
    return following.filter(f => !followerIds.has(f.node.id));
}

function createTableRow(user, index, followers, whitelistSet) {
    const isFollowing = followers.some(f => f.node.id === user.node.id);
    const rowClass = isFollowing ? 'following-user' : 'not-following-user';
    const isWhitelisted = whitelistSet && whitelistSet.has(user.node.username);

    const originalProfileUrl = user.node.profile_pic_url;

    const followingBadgeText = isFollowing ? getMessage('followingYouBadge') : getMessage('notFollowingYouBadge');
    const unfollowText = getMessage('unfollow');
    const whitelistTitle = isWhitelisted ? getMessage('removeFromWhitelist') : getMessage('addToWhitelist');

    return `
        <tr class="${rowClass}${isWhitelisted ? ' whitelisted-row' : ''}" data-username="${user.node.username}" data-fullname="${user.node.full_name || ''}">
            <td class="row-number">${index + 1}</td>
            <td>
                <div class="profile-cell">
                    <img src="${originalProfileUrl}" data-orig="${originalProfileUrl}" referrerpolicy="no-referrer" alt="Profile" class="profile-image" onerror="this.onerror=null;this.src='img/48.png'">
                </div>
            </td>
            <td>
                <a href="https://instagram.com/${user.node.username}" target="_blank" class="username-cell">@${user.node.username}</a>
            </td>
            <td>${user.node.full_name}</td>
            <td>${user.node.is_verified ? '<span class="verified-badge"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg></span>' : ''}</td>
            <td>
                <span class="${isFollowing ? 'following-badge' : 'not-following-badge'}">
                    ${followingBadgeText}
                </span>
            </td>
            <td class="action-cell">
                <button class="whitelist-btn${isWhitelisted ? ' active' : ''}" data-username="${user.node.username}" title="${whitelistTitle}">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="${isWhitelisted ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>
                </button>
                <button class="unfollow-btn" data-username="${user.node.username}" data-userid="${user.node.id}">${unfollowText}</button>
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
function getFilteredData() {
    if (showOnlyNonFollowersFilter) {
        return allDisplayData.filter(user =>
            !allFollowersList.some(f => f.node.id === user.node.id)
        );
    }
    return allDisplayData;
}

function renderCurrentPage() {
    const filtered = getFilteredData();
    totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    if (currentPage > totalPages) currentPage = totalPages;

    const start = (currentPage - 1) * PAGE_SIZE;
    const pageData = filtered.slice(start, start + PAGE_SIZE);

    if (elements.followingList) {
        elements.followingList.innerHTML = pageData.map((user, i) =>
            createTableRow(user, start + i, allFollowersList, currentWhitelistSet)
        ).join('');
    }

    if (window.loadAvatar) {
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

// Filter kontrolü için event listener
function setupFilterListener() {
    const filterCheckbox = document.getElementById('showOnlyNonFollowers');
    if (filterCheckbox) {
        filterCheckbox.addEventListener('change', function() {
            showOnlyNonFollowersFilter = this.checked;
            currentPage = 1;
            renderCurrentPage();
        });
    }
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
            usedFollowsViewer = false;
            realFollowersTotal = null;

            // Ask the one query that already knows the answer. It reads the following list only,
            // so the followers list — the long one, the one the throttle lands on — is never read.
            const withStatus = await readFollowingWithStatus(userId);

            if (withStatus) {
                usedFollowsViewer = true;
                followingList = withStatus.users;
                // Everything downstream diffs `following` against `followers` by id, so the same
                // answer is expressed in the shape that code already speaks: the followers it
                // needs are exactly the ones that follow back. It is not the whole followers list
                // and is not treated as one — see realFollowersTotal below.
                followersList = withStatus.users.filter((u) => u.node.follows_viewer);
                realFollowersTotal = await getExpectedOnce(userId, 'followers');

                lastScanInfo.following = {
                    complete: true, reason: withStatus.reason, count: followingList.length,
                    source: withStatus.source, requests: withStatus.requests
                };
                lastScanInfo.followers = {
                    complete: true, reason: 'follows_viewer', count: followersList.length
                };
            } else {
                // Sequential, and followers first. Two parallel streams double the request rate against
                // an endpoint that throttles, and it is the followers list whose truncation does the
                // damage — if it comes back short there is no point spending requests on the other one.
                followersList = await getFollowersList(userId);
                followingList = await getFollowingList(userId);
            }

            // Only a complete pair is worth keeping. A truncated list cached here would poison
            // every later session, which is how the old reader turned one bad scan into a habit.
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

            // Cumulative limit - show up to totalLimit (always show, never block)
            const maxToShow = Math.min(
                followingList.length,
                dailyLimit.totalLimit || 50
            );

            displayList = followingList.slice(0, maxToShow);
            isLimited = true;

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
        showOnlyNonFollowersFilter = false;
        const filterCheckbox = document.getElementById('showOnlyNonFollowers');
        if (filterCheckbox) filterCheckbox.checked = false;

        // Render first page
        renderCurrentPage();
        renderScanDiag();

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
        const nonFollowers = followingList.filter(user =>
            !followersList.some(f => f.node.id === user.node.id)
        );
        
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
            elements.followersCount.textContent = followersCount.toLocaleString('tr-TR');
        }
        if (elements.followingCount) {
            elements.followingCount.textContent = followingCount.toLocaleString('tr-TR');
        }
        if (elements.nonFollowersCount) {
            elements.nonFollowersCount.textContent = nonFollowersCount.toLocaleString('tr-TR');
        }

        // Show trend comparison with previous analysis
        const prevSnapshot = await getLastAnalysisSnapshot(userId);
        if (prevSnapshot && prevSnapshot.previous) {
            const prev = prevSnapshot.previous;
            showTrend('followersCount', followersCount - prev.followersCount);
            showTrend('followingCount', followingCount - prev.followingCount);
            showTrend('nonFollowersCount', nonFollowersCount - prev.nonFollowersCount);
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
    // credentials matters here: without the session cookie Instagram still answers 200 with JSON,
    // but the token it hands back is an anonymous one. Signing an unfollow with that token gets
    // the request rejected — and the rejection arrives as 200 with an HTML login page, which is
    // exactly the "it worked but nothing happened" symptom.
    const response = await fetch('https://www.instagram.com/data/shared_data/', {
        credentials: 'include'
    });
    handleInstagramApiError(response);
    const data = await response.json();
    cachedCsrfToken = data?.config?.csrf_token || null;
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
async function findWriteProbeTarget(followingIds) {
    const fromMemory = allFollowersList.find((f) => f.node.id && !followingIds.has(f.node.id));
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
    return sample.find((f) => f.node.id && !followingIds.has(f.node.id)) || null;
}

async function probeWritePath() {
    if (cachedWriteProbe === 'open') return 'open';
    if (cachedWriteProbe === 'blocked' && Date.now() - writeProbeAt < WRITE_PROBE_BLOCKED_TTL_MS) {
        return 'blocked';
    }

    // Someone who follows this account but is not followed back: unfollowing them is a no-op.
    // Built from the complete following list, never the display slice — a wrong answer here would
    // mean really unfollowing somebody during a check that is supposed to change nothing.
    if (!allFollowingFull.length) return 'unknown';
    const followingIds = new Set(allFollowingFull.map((u) => u.node.id));
    const target = await findWriteProbeTarget(followingIds);
    if (!target) return 'unknown';

    try {
        // Probes the same two endpoints the real unfollow uses, in the same order, so the answer
        // reflects what a run would actually meet rather than one path's health.
        await unfollowUser(target.node.username, target.node.id);
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
async function postUnfollow(url, headers) {
    let response;
    try {
        response = await fetch(url, { method: 'POST', credentials: 'include', headers, body: '' });
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

async function unfollowUser(username, userId) {
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
                }
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
            const row = this.closest('tr');
            const fullName = row?.dataset.fullname || '';

            try {
                this.disabled = true;
                this.textContent = getMessage('unfollowing');

                // The id is on the button, so the username never has to be resolved again.
                const success = await unfollowUser(username, this.dataset.userid);

                if (success) {
                    this.textContent = getMessage('unfollowedSuccess');
                    this.classList.add('unfollowed');
                    row.classList.add('unfollowed-row');
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
            const isActive = this.classList.contains('active');

            if (isActive) {
                await removeFromWhitelist(currentUserId, username);
                this.classList.remove('active');
                this.querySelector('svg').setAttribute('fill', 'none');
                this.title = getMessage('addToWhitelist');
                if (row) row.classList.remove('whitelisted-row');
            } else {
                await addToWhitelist(currentUserId, username);
                this.classList.add('active');
                this.querySelector('svg').setAttribute('fill', 'currentColor');
                this.title = getMessage('removeFromWhitelist');
                if (row) row.classList.add('whitelisted-row');
            }
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
    const followerIds = new Set(allFollowersList.map(f => f.node.id));
    return allDisplayData.filter(user => {
        if (currentWhitelistSet.has(user.node.username)) return false;
        if (user._unfollowed) return false;
        if (user._unfollowError) return false;
        if (mode === 'nonFollowers') return !followerIds.has(user.node.id);
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
    const queue = buildUnfollowQueue('nonFollowers');

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
    const queue = buildUnfollowQueue('everyone');

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
        const fullName = user.node.full_name || '';

        // Navigate to the page containing this user (filtre-aware)
        const filtered = getFilteredData();
        const filteredIndex = filtered.indexOf(user);
        const targetPage = filteredIndex >= 0 ? Math.floor(filteredIndex / PAGE_SIZE) + 1 : currentPage;
        if (targetPage !== currentPage) {
            currentPage = targetPage;
            renderCurrentPage();
            await new Promise(r => setTimeout(r, 300));
        }

        // Find row in DOM - retry once if not found after page render
        let row = document.querySelector(`tr[data-username="${username}"]`);
        if (!row) {
            await new Promise(r => setTimeout(r, 200));
            row = document.querySelector(`tr[data-username="${username}"]`);
        }
        const unfollowBtn = row?.querySelector('.unfollow-btn');

        try {
            // Wait before each unfollow - zaman damgası tabanlı (sekme throttling'den etkilenmez)
            const waitSeconds = unfollowDelay / 1000;
            if (waitSeconds > 0) {
                await new Promise((resolve) => {
                    const endTime = Date.now() + (waitSeconds * 1000);
                    unfollowEndTime = endTime; // Global referans (visibilitychange için)

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

            // Update DOM if row is visible
            if (row) {
                row.scrollIntoView({ behavior: 'smooth', block: 'center' });
                row.classList.add('processing');
            }
            if (unfollowBtn) {
                unfollowBtn.disabled = true;
                unfollowBtn.classList.add('loading');
                unfollowBtn.innerHTML = `<span class="loading-spinner-small"></span>`;
            }

            // The queue entry already carries the id, so the bulk run no longer spends a
            // web_profile_info request per account resolving a username it started from.
            const success = await unfollowUser(username, user.node.id);

            if (unfollowBtn) unfollowBtn.classList.remove('loading');

            if (success) {
                // Mark in global data
                user._unfollowed = true;

                if (row) {
                    row.classList.remove('processing');
                    row.classList.add('unfollowed-row');
                }
                if (unfollowBtn) {
                    unfollowBtn.innerHTML = `<span class="success-icon">✓</span> ${getMessage('unfollowedSuccess')}`;
                    unfollowBtn.disabled = true;
                    unfollowBtn.classList.add('unfollowed');
                }

                if (currentUserId) {
                    removeUserFromCache(currentUserId, username);
                }
                if (nonFollowersCount > 0) {
                    nonFollowersCount--;
                    updateStats();
                }
            } else {
                if (row) row.classList.remove('processing');
                if (unfollowBtn) {
                    unfollowBtn.textContent = getMessage('unfollowFailed');
                    unfollowBtn.disabled = false;
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
                let message = getMessage('nextInSeconds') || 'Sonraki: $SECONDS$s';
                
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
                    message = `Sonraki: ${secondsInt}s`;
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
    // İstatistik elementlerini bul ve güncelle
    const followersElement = document.getElementById('followersCount');
    const followingElement = document.getElementById('followingCount');
    const nonFollowersElement = document.getElementById('nonFollowersCount');

    if (followersElement) {
        followersElement.textContent = followersCount.toLocaleString('tr-TR');
    }
    if (followingElement) {
        followingElement.textContent = followingCount.toLocaleString('tr-TR');
    }
    if (nonFollowersElement) {
        nonFollowersElement.textContent = nonFollowersCount.toLocaleString('tr-TR');
    }
}

// Kullanıcı bilgilerini al ve göster
async function displayUserInfo() {
    try {
        const response = await fetch('https://www.instagram.com/data/shared_data/', {
            credentials: 'include'
        });
        const data = await response.json();
        const user = data.config.viewer;

        if (user) {
            const userAvatar = document.getElementById('userAvatar');
            const userInfo = document.querySelector('.user-info');

            if (userAvatar && user.profile_pic_url) {
                // Görseli yüklemeye başla
                userAvatar.src = user.profile_pic_url;
                if (window.loadAvatar) loadAvatar(userAvatar, user.profile_pic_url);
                
                // Görsel yüklendiğinde
                userAvatar.onload = () => {
                    userAvatar.classList.add('loaded');
                    userInfo.classList.add('loaded');
                };
            }

            const userName = document.getElementById('userName');
            if (userName) {
                userName.textContent = user.username;
            }

            const userEmail = document.getElementById('userEmail');
            if (userEmail) {
                userEmail.textContent = user.email || '@' + user.username;
            }

            // User info'yu görünür yap
            if (userInfo) {
                userInfo.style.display = 'block';
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
