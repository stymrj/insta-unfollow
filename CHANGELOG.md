# Changelog

## 3.0.6 — 2026-11-26

### Authoritative Relationship Reconciliation, Shortfall Merge & Live Version Badge
- **Eliminated Omitted-Follower False Negatives (`v3.0.6`):**
  - Restored `FOLLOWS_VIEWER_HASH` (`readFollowingWithStatus`) as the primary reader for **all** account sizes (not only `> 1,500` followers), avoiding the 2–9% follower-list omissions Instagram applies on `/api/v1/friendships/{id}/followers/`. Added automatic bare-credential retry on GraphQL soft-refusals.
  - Added `UnfollowBridge.verifyUsersFollowBack()` + pre-render authoritative reconciliation against `GET /api/v1/friendships/show/{id}/` (`followed_by`) whenever the two-list fallback runs, plus `scheduleVisibleRowVerification()` to live-verify visible `Not Following You` rows in the background and flip any mutual follower to **Following You** immediately.
  - Upgraded `scanPeers` with persistent `rank_token` UUID pagination, gentler Web pacing (`650–1200ms`), and automatic V1 ↔ GraphQL union merge when the primary transport stops below 96% of expected counts.
  - Upgraded `getExpectedCounts()` to resolve counts across Web Polaris GraphQL, 1-node GraphQL edge counts, `users/{id}/info/`, and profile storage so desktop Chrome sessions always know exact expected counts.
  - Bumped `ANALYSIS_CACHE_VERSION = 4` and added a live `#appVersionBadge` (`v3.0.6`) pill in the Analyzer header so the active build version is immediately visible.

## 3.0.5 — 2026-11-25

### Critical Scan Engine Reconstruction, Pre-Unfollow Mutual Protection & Filter/UI Overhaul
- **Eliminated False "Not Following You" Bug at Root Cause:**
  - Removed `POST /api/v1/friendships/show_many/` from follow-back detection completely: on Instagram Web (`X-Ig-App-Id: 936619743392459`), `show_many` omits `followed_by`, which caused mutual followers to be marked `follows_viewer = false`.
  - Restored strict `FOLLOWS_VIEWER_HASH` GraphQL reader requiring an explicit boolean `follows_viewer` on every node (`no_status` fallback otherwise) plus `verifyStatusScanHonesty()` cross-checking against live `readFollowersSample` and `GET /api/v1/friendships/show/{id}/`.
  - Direct two-list comparison (`followers` + `following`) now leads for accounts up to 1,500 followers and stamps explicit boolean `follows_viewer` across every row; larger accounts run spot-verified status scans with automatic V1 ↔ GraphQL fallback.
  - Fixed `readV1Page` premature Page-1 cutoff (`has_more === false` ignored when `next_max_id` is present) and restored live `api/v1/users/{id}/info/` expected counts so truncated scans are never marked complete.
  - Bumped `ANALYSIS_CACHE_VERSION = 3` (and `BOT_SCAN_CACHE_VERSION = 2`) with zero-mutual cache poisoning rejection so corrupted caches from `v3.0.0–v3.0.4` are invalidated automatically.
- **Triple-Layer Mutual Protection Before Unfollow:**
  - Added `UnfollowBridge.checkFriendshipStatus(userId)` (`GET /api/v1/friendships/show/{id}/`) live pre-unfollow circuit breaker inside `processUnfollowQueue`: before unfollowing any queued non-follower (and again after any >30s pause), verifies `followed_by !== true` on Instagram's server and skips/updates the row live if they follow back.
  - Added mutual-follower confirmation dialog + live relationship check on manual single-row unfollows.
  - Hardened `probeWritePath()` with normalized ID + username checks and live `checkFriendshipStatus` verification (`following === false && outgoingRequest === false`) so pre-flight probes can never touch a followed account.
- **Filtering, Whitelist, Free Plan & Promo Fixes:**
  - Fixed whitelist toggle to immediately update `currentWhitelistSet` in memory and disable/enable row unfollow buttons so newly whitelisted users are excluded from unfollow queues and reflected in the `Whitelisted` filter immediately.
  - Synchronized `.filter-chip` tabs with the `#showOnlyNonFollowers` switch (`setActiveFilterChip`), made `setupFilterListener` idempotent, and added live counts on every filter chip.
  - Prioritized non-followers first when slicing rows on the Free plan so non-followers are never hidden behind mutuals.
  - Fixed `background.js` `resolveMembership` overwriting active local promo-code grants (`grantExpiresAt`) with `free`, and fixed `showCustomModal` boolean return handling.
- **UI & Accessibility Polish:**
  - Fixed 4-column stat card wrapping on Bot Scan (`repeat(auto-fit, minmax(200px, 1fr))`), sticky table headers, accessible keyboard-scrollable table regions (`tabindex="0"`, `role="region"`), status indicator pills, distinct mutual outline buttons, and dimmed `.unfollowed-row` state.

## 3.0.4 — 2026-11-25

### Follower Detection 100% Accuracy & Modern UI System Overhaul
- **Follower Detection Bug Completely Resolved:**
  - Resolved the false-negative follower bug where mutual followers who follow the viewer back were occasionally shown as "Not following you".
  - Implemented dual ID and case-insensitive username matching (`isUserFollowingMe`) across all views, filters, sort orders, and unfollow queues.
  - Added direct inspection of `user.node.follows_viewer` from friendship status endpoints.
  - Added cache schema versioning (`ANALYSIS_CACHE_VERSION = 2`) that automatically invalidates legacy incomplete caches where `follows_viewer` flags and usernames were omitted.
  - Fixed `_csrftoken` injection and extended friendship status detection in `unfollow-bridge.js`.
- **Modern UI & Design System Overhaul:**
  - Fixed global button CSS bugs where button icons were turning mustard yellow and secondary buttons had unreadable text.
  - Overhauled control panel with vibrant, modern indigo gradients, smooth drop shadows, and 10px rounded corners.
  - Upgraded table row action buttons: sleek outline unfollow button with smooth hover state, clean bookmark whitelist button.
  - Redesigned follower badges into modern pill badges with soft green/red backgrounds and clear typography.
  - Overhauled Overview stat cards with clean floating white card aesthetics and distinct metric colors.


### Admin Promo Management & Follower Status Fix
- **Version Bump:** Bumped to 3.0.3 to satisfy Chrome Web Store package version sequence.
- **Visual Promo Code Manager:** Added complete promo creation, copying, and deletion inside Admin Console.

## 3.0.2 — 2026-11-24

### Bug Fixes, Promotional Redeem Codes & Admin Growth Tools
- **Mutuals & Follower Detection Engine Overhauled:** Fixed critical false-negative bug where users following back were marked as "Not following you". `showMany` query is now chunked in safe batches of 30 with retry resilience, preventing 400 Bad Request dropped statuses.
- **Promotional Redeem Code System:** Added promo code redemption in the extension modal and popup. Users can redeem codes (e.g. `FREE10`, `WELCOME10`, `PROMO10`) for 10 days of free unlimited premium.
- **Admin Console Allotment & Bulk Grant:** Added custom day allotment (10 days, 7 days, 14 days, custom days) and 1-click **"Grant 10d to All Free Users"** bulk button.
- **Admin Users CSV Export:** Added 1-click **"Export Users (CSV)"** button in Admin Console to easily export user names and emails for email marketing campaigns.
- **Admin Table UI & Controls Restyled:** Fixed ugly multi-line button wrapping in table rows; styled select dropdowns, ghost buttons, and toolbar.

## 3.0.1 — 2026-11-24

### Store Reviews URL & Author Attribution
- **Store Review URL Pointed Directly to Web Store:** Smart review and rating banner now directly opens the published Chrome Web Store listing review page (`kdlobnohhjkneflmopckfidfekdkokcd/reviews`), ensuring review claims reliably register.
- **Author Attribution:** Added verified LinkedIn profile hyperlink for creator [Satyam Raj](https://www.linkedin.com/in/satyamraj1) in the popup footer.

## 3.0.0 — 2026-11-23

### Major V3 Release: Complete Modern Redesign, Zero-Throttling Engine & Growth System
- **Modern UI Redesign:** Brand new glassmorphic dashboard for the Scan (Analyzer) page and Premium Purchase modal with frosted glass backdrop blur, animated metric cards, high-contrast action command bar, and streamlined UPI checkout.
- **Strict Content Security Policy (CSP) Compliance:** Eliminated all inline `onerror` and `onclick` event handlers across all pages and template strings. Switched to CSP-compliant capturing error event listeners.
- **Smart Review Prompt with +100 Bonus Unfollows:** Built an anti-annoyance review prompt that rewards users who rate 5 stars on the Chrome Web Store with +100 free bonus unfollows. Respects a 7-day snooze cooldown and never prompts again once rated or dismissed.
- **Instant Profile Loading & Avatar Resilience:** Fixed avatar load timeouts and state blocking. Ensured username and profile details always display instantly even under network restrictions.
- **Zero-Throttling Following & Mutuals Engine:** Batched friendships `showMany` query prevents 429 lockouts from Instagram's followers endpoint.

## 2.0.6 — 2026-11-23

### The session now comes from your browser's own cookies — zero requests
- **The proof:** Unfollow Pro (v2.14.7, tested working on the same account) reads the viewer id from Chrome's own Instagram cookies — `ds_user_id` IS the numeric id, `sessionid` proves the session — with zero network requests. Our extension was burning 5–6 API requests to discover the same id, and those are exactly the requests Instagram throttles.
- **The fix:** `fetchSession` now reads `ds_user_id` + `csrftoken` from the browser cookies first (new `cookies` permission), then fills in the username/avatar with one `users/{id}/info/` call. No cookie, no problem — the API chain (homepage → `current_user` → `web_form_data` → `usernameinfo` → profile page) still runs as before. Privacy policy updated with a cookies line.
- **Tests:** 39/39, including a real-browser check with a planted `ds_user_id` cookie.

## 2.0.5 — 2026-11-21

### A rate limit no longer gets worse every time you retry
- **What happened:** after a day of repeated Analyze attempts, Instagram started 429-ing the session calls — the popup correctly showed "Instagram is limiting requests right now". The account is fine; the limit lifts on its own (hours, sometimes tomorrow).
- **The fix:** a rate-limit refusal is now cached for 5 minutes, in memory and in storage (the popup is a fresh page on every open, so memory alone would not survive it). While it is fresh, `fetchSession` answers from the cache and sends NO request to Instagram at all — retrying into a limit is the one thing that makes it last longer. The screen still says to wait; now the code waits too.

## 2.0.4 — 2026-11-21

### The id now comes from Instagram's own APIs, not from HTML
- **The diagnosis (from v2.0.3's own detail):** `homepage: ok, no viewer; web_form_data: signed in as @satyamgupta2_; profile page: ok, no id found`. Verified against the real pages: Instagram's homepage fetch now returns a shell with no viewer block, and the profile page returns an error page to fetches — HTML can no longer identify anyone. The API endpoints still answer.
- **The fix:** the chain now reads the id from `api/v1/accounts/current_user/` (needs no username) and, failing that, `api/v1/users/<username>/usernameinfo/` (username from `web_form_data`). Both endpoints were verified to exist (401/403/429, never 404). The profile-page HTML read stays as a last resort. A 429 on `usernameinfo` no longer ends the attempt — the profile page still follows — and a `web_form_data` failure keeps going when the homepage already gave a username.
- **Also:** the harness caught a real bug in the first draft of this fix (`usernameinfo` 429 short-circuiting the attempt) — fixed and covered.

## 2.0.3 — 2026-11-21

### Session failures now say exactly what failed (and which build said it)
- **The problem:** "Instagram is temporarily unavailable" hid the cause — it could be the homepage dropping, the API refusing, or the profile page hiding the id — and it hid which build was even running, so a still-failing 2.0.1 looked identical to a failing 2.0.2.
- **The fix:** `fetchSession()` now returns a `detail` string naming every step ("homepage: network error; web_form_data: 500"), and the analyzer's error shows it plus the build version, e.g. "Instagram is temporarily unavailable. Please try again later. — homepage: 429; web_form_data: 429 [v2.0.3]". The same detail is written to the on-page scan diagnostics.
- **Also:** the profile-page fallback (step 3) now tries twice with a 1.5s gap — a single dropped request no longer turns a proven signed-in session into "unavailable".

## 2.0.2 — 2026-11-21

### Session bootstrap: a dropped homepage request no longer kills Analyze
- **The bug:** `fetchSession()` returned `refused` the moment the Instagram homepage fetch failed (dropped request, 429, 5xx) — before `web_form_data` ever ran. In a real browser that surfaced as "Instagram is temporarily unavailable. Please try again later." on Analyze, even though the lightweight API endpoint would have answered.
- **The fix:** a homepage failure now only records the failure and the attempt continues to `web_form_data` (401/403 there is still the definitive "nobody is signed in"; the profile-page fallback still covers a signed-in user whose id the homepage hid). A `refused` with reason `network` or `server` is retried once after 2s; rate-limit and signed-out results are never retried.
- **Also:** the unpacked-build `key` (2.0.1) and its registered redirect URI carry over unchanged — same dev id `gpgcdajecndabpbigkblhbojakohoiil`.

## 2.0.1 — 2026-11-21

### Session bootstrap fix (Instagram removed `/data/shared_data/`)
- **Analyze was broken for every user after v2.0.0 went live:** Instagram removed `https://www.instagram.com/data/shared_data/` (it now answers 404), and that endpoint was the extension's session bootstrap — viewer id, username and csrf token for the analyzer, the popup's sign-in check, the bot scan and every unfollow all started there. A 404 threw the generic "An error occurred while fetching data" before any list was read (0 followers / 0 following / 0 not following). This was not a v2 regression: v1.0.0 read the same endpoint and breaks identically.
- **New shared helper `ig-session.js`** (loaded before its callers in analyzer.html, bot-scan.html and popup.html, and injected into the Instagram tab by ig-content.js before unfollow-bridge.js; added to manifest `web_accessible_resources`): reads the viewer id, username and csrf token off the Instagram homepage HTML, confirms the sign-in with `api/v1/accounts/edit/web_form_data/` (401/403 = signed out, 429/5xx = throttled), and falls back to the public profile page for the id when the homepage hides it. A csrf token alone never counts as a session — the logged-out page carries one too. `fetchSession()` never throws; it returns `ok` / `logged_out` / `refused`, the same three-way answer the old check gave callers.
- **Call sites switched over:** analyzer `getCurrentUserId` (session found / not signed in / rate-limited messages preserved), `getCsrfTokenOnce` (prefers the viewer already fetched for the analysis), `displayUserInfo` (avatar from the homepage parse, `users/{id}/info/` as fallback); popup `checkInstagramLogin` (same login vs limited alerts as before); bridge `getViewer` (degrades to null when the helper is absent, so an older injected page script falls back to the extension-page read instead of throwing).
- **Not verifiable from here:** the list reads (v1 friendships / graphql) and the unfollow flow can only be exercised with a logged-in Instagram session — test with the 2.0.1 zip loaded unpacked (see `docs/v2-testing.md`).
- **Unpacked test builds keep a fixed extension id (2026-11-21):** loading the zip unpacked used to give Chrome a random id, so Google sign-in failed with `redirect_uri_mismatch` (the OAuth client only knew the store id's redirect). `manifest.json` now carries a `"key"` (public key only; the private key is at `~/workspace/iu-dev-key.pem`, never committed, never in the zip) pinning the unpacked id to `gpgcdajecndabpbigkblhbojakohoiil`, and `https://gpgcdajecndabpbigkblhbojakohoiil.chromiumapp.org/` is registered as a third redirect URI on the same OAuth client (store id's URI untouched). The store strips/ignores the key on upload, so this changes nothing about the published listing.

## 2.0.0 — 2026-11-06

### Design
- Replaced the beige "paper & ink" editorial theme with a modern clean light theme: white / `#fafafa` backgrounds, `#262626` ink, Inter throughout, Instagram gradient accent (`#feda75 → #fa7e1e → #d62976 → #962fbf → #4f5bd5`) on primary buttons, active states and the logo, 12px rounded cards, soft shadows. Light-only, no dark mode. **Superseded 2026-11-19 — see revision note below.**
- **2026-11-19 revision — Design B "Colourful bold" (Satyam's pick).** The white / Instagram-gradient theme above was rejected by Satyam on 2026-11-06 ("too much worst design"). It was replaced with the design he picked from three mockups: deep indigo/navy header (`#1e1b4b`) with a 4px amber (`#f59e0b`) rule, lavender-grey page (`#eef2ff`), white cards, solid indigo primary actions (`#4f46e5`), solid red danger (`#dc2626`), amber / green / rose stat fills, indigo table header — applied consistently to the analyzer, popup, bot scan, admin console and premium modal, with no gradient anywhere. All store screenshots, promo tile and marquee regenerated from the real B theme.
- Regenerated all store screenshots, promo tile (440×280) and marquee (1400×560) from the new UI with headless Chromium (`screenshots/` and `store-assets/`).
- Fixed two v1 rendering bugs found while screenshotting: secondary buttons had white text on a white button (unreadable), and the premium modal had a 4px black top border.

### Features
- Analyzer: search box (username / full name), sort (Default order, Username A–Z, Not following first), filter chips (All / Not following back / Following back / Whitelisted), Export CSV and Copy usernames — all client-side over the already-loaded list, pagination untouched.
- Analyzer: the since-last-analysis trend now compares with the **last** analysis (v1 compared with the analysis before that, skipping the most recent one) and shows a readable line under Not Following, e.g. "+7 since last analysis · 4 Nov 2026", using the real stored snapshot values.
- Popup: Last Analysis summary card (followers / following / not-following / scan date) with a View results button; hidden cleanly when no analysis exists yet. The analyzer writes one small `lastAnalysisSummary` key so the popup can read it without knowing the Instagram user id.
- Bot scan: Export flagged CSV (username, full name, verdict, score %, raw score, reasons, deep-checked) from the already-computed scores — no new requests.

### Payments, admin & reliability fixes (2026-11-19 — same 2.0.0, before store publish)

- **Price decision (updated 2026-11-19, same evening — supersedes the ₹199/₹1,499 decision just above in history): five plans, INR, set by the owner — 1 month ₹49 (₹49/mo), 3 months ₹129 (₹43/mo; strike ₹147, save ₹18), 6 months ₹249 (₹42/mo; strike ₹294, save ₹45), 9 months ₹399 (₹44/mo; strike ₹441, save ₹42), 12 months ₹499 (₹42/mo; strike ₹588, save ₹89).** Every plan genuinely saves vs buying months one at a time. Fixed in popup, premium modal, store description. The worker now sends Razorpay amounts in paise as Razorpay requires: `4900` / `12900` / `24900` / `39900` / `49900`.
- **Premium now actually expires.** The worker records `paidAt`/`expiresAt` (30 days for 1 month, 90 days for 3 months, 180 days for 6 months, 270 days for 9 months, 365 days for 12 months) the first time a paid link is seen and signs every later token with that same expiry. Previously every status check signed a fresh 365 days, so one payment meant premium forever.
- **Dead payment links are never reused.** An expired/cancelled Razorpay link now yields a fresh link instead of being handed back to the user.
- **Razorpay webhook added** (`POST /webhook/razorpay`, HMAC-SHA256 verified against new env var `RAZORPAY_WEBHOOK_SECRET`): premium activates the moment Razorpay reports `payment_link.paid`, even if the user closed the tab. Status polling remains as fallback. Redeploy required — see `docs/worker-deploy.md`.
- **Auth added to `/create-link` and `/register`:** a Google access token whose user id matches the request is now required; `/status` stays public (its token is signed and bound to the user).
- **`/status` no longer hammers Razorpay:** an unpaid link checked < 5 min ago returns `premium:false` from cache.
- **Popup Subscribe now polls like the premium modal** (shared `pollPremiumActivation` helper, every 4s up to 5 min) and shows a waiting state; paying from the popup no longer leaves the user on Free until reopen. Subscribe errors now name the real problem instead of "Set PAYMENT_API_URL".
- **One membership source of truth:** the background script now asks the worker on login/status checks, so an admin revoke/ban takes effect on the next check; local token is only a fallback when the worker is unreachable. Tokens are accepted only when their `sub` matches the logged-in Google id.
- **Expiry is visible:** popup shows "Premium until 12 Dec 2026" when premium; admin list shows plan, paid date and days-left for paid users as well as grants.
- **Admin console fixes:** membership is expiry-aware (expired grants/payments show Free, not Premium); the user list now pages past the first 500 users (was stuck at 500); grants store the real plan (`trial`/`1mo`/`3mo`/`6mo`/`9mo`/`12mo`); revoke keeps the payment record (marked revoked) instead of deleting it; `/admin/users` returns plan / paid date / expiry / revoked / link status.
- **Manual payments (2026-11-19 — same 2.0.0, before store publish): UPI + screenshot proof replaces Razorpay as the way users pay.** UPI is offline in the extension — the owner's static Paytm QR (`img/paytm-qr.jpg`, UPI ID `paytmqr69wd1y@ptys`), copy-UPI-ID and a UPI-app deep link with the plan amount prefilled. There is NO Paytm payment-link option: Paytm dashboard links expire after max 3 days, so a static link would die in 3 days (users can still pay with the Paytm app by scanning the same UPI QR). After paying, the user uploads a screenshot of the payment (UTR optional) as a proof, which stays **pending** until reviewed: the admin console has a "Pending payments" section with View (opens the screenshot), Approve (grants 30 days for 1 month, 90 days for 3 months, 180 days for 6 months, 270 days for 9 months, 365 days for 12 months) and Reject (optional reason; the user can submit a new proof). Manual payments need no webhook and no Razorpay keys — the Razorpay webhook code stays in the worker but is dormant without keys. Setup: see `docs/worker-deploy.md`.
- **Not done (deliberately): server-side free limits.** Enforcing daily scan limits from the worker touches the analyzer's scan flow and could break analysis. Free limits remain enforced locally in the extension as before.

### Honesty / trust fixes
- Removed fake social proof everywhere: "10,000+ Active Users", "4.8/5 Rating", and the fake live counter "150 people upgraded in the last 24h" (which reset to 150 every day and counted up to 350). Replaced with "Your data stays on your device — nothing is uploaded." No user or rating numbers are claimed anywhere now.
- Pricing math: $25 → $6.99 is **72% OFF**, not 50% OFF. Fixed consistently in the popup, the analyzer premium modal, and `_locales/en/messages.json` (`discountOff`). The 12-month $129.99 → $74.99 stays 42% OFF (already correct). **Superseded 2026-11-19 by the ₹ pricing in the section above** — the $ figures no longer appear in the UI.
- Turkish leftovers: "(+20/gün)" → "(+20/day)", "Sonraki: 120s" → "Next: 120s", and the Turkish live-counter strings removed with the counter.
- Free plan wording standardised everywhere: "40 analyses on day 1, +20 every day, 50 unfollows/day" (was "Max 40 following analysis").

### Not in 2.0.0 (deliberately)
- **No per-account Followers column in the analyzer.** Instagram's following-list API returns only id / username / full name / verified / profile picture — no follower count per account. Adding the column would need one profile request per followed account, which is exactly the kind of extra traffic the rate-limit safety logic exists to avoid. The v1 store screenshot showed such a column; it was a mock, and the v2 screenshot no longer shows it.
- **No Bot Score column in the analyzer.** Bot-scan scores are computed in memory during a scan and never written to storage, so there is nothing honest to join against. (Storing scores is possible future work.)
- **No "Most followers" sort.** Same reason as the Followers column — the field does not exist in the loaded data.
- Unfollow delays, pacing, retry/backoff and all Instagram request code are unchanged.

## 1.0.0 — 2026-08
- Initial Chrome Web Store release: non-followers analyzer, safe unfollow flow with whitelist, bot scan, free/premium plans.
