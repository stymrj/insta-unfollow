# Changelog

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
