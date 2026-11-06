# Changelog

## 2.0.0 — 2026-11-06

### Design
- Replaced the beige "paper & ink" editorial theme with a modern clean light theme: white / `#fafafa` backgrounds, `#262626` ink, Inter throughout, Instagram gradient accent (`#feda75 → #fa7e1e → #d62976 → #962fbf → #4f5bd5`) on primary buttons, active states and the logo, 12px rounded cards, soft shadows. Light-only, no dark mode.
- Regenerated all store screenshots, promo tile (440×280) and marquee (1400×560) from the new UI with headless Chromium (`screenshots/` and `store-assets/`).
- Fixed two v1 rendering bugs found while screenshotting: secondary buttons had white text on a white button (unreadable), and the premium modal had a 4px black top border.

### Features
- Analyzer: search box (username / full name), sort (Default order, Username A–Z, Not following first), filter chips (All / Not following back / Following back / Whitelisted), Export CSV and Copy usernames — all client-side over the already-loaded list, pagination untouched.
- Analyzer: the since-last-analysis trend now compares with the **last** analysis (v1 compared with the analysis before that, skipping the most recent one) and shows a readable line under Not Following, e.g. "+7 since last analysis · 4 Nov 2026", using the real stored snapshot values.
- Popup: Last Analysis summary card (followers / following / not-following / scan date) with a View results button; hidden cleanly when no analysis exists yet. The analyzer writes one small `lastAnalysisSummary` key so the popup can read it without knowing the Instagram user id.
- Bot scan: Export flagged CSV (username, full name, verdict, score %, raw score, reasons, deep-checked) from the already-computed scores — no new requests.

### Honesty / trust fixes
- Removed fake social proof everywhere: "10,000+ Active Users", "4.8/5 Rating", and the fake live counter "150 people upgraded in the last 24h" (which reset to 150 every day and counted up to 350). Replaced with "Your data stays on your device — nothing is uploaded." No user or rating numbers are claimed anywhere now.
- Pricing math: $25 → $6.99 is **72% OFF**, not 50% OFF. Fixed consistently in the popup, the analyzer premium modal, and `_locales/en/messages.json` (`discountOff`). Yearly $129.99 → $74.99 stays 42% OFF (already correct).
- Turkish leftovers: "(+20/gün)" → "(+20/day)", "Sonraki: 120s" → "Next: 120s", and the Turkish live-counter strings removed with the counter.
- Free plan wording standardised everywhere: "40 analyses on day 1, +20 every day, 50 unfollows/day" (was "Max 40 following analysis").

### Not in 2.0.0 (deliberately)
- **No per-account Followers column in the analyzer.** Instagram's following-list API returns only id / username / full name / verified / profile picture — no follower count per account. Adding the column would need one profile request per followed account, which is exactly the kind of extra traffic the rate-limit safety logic exists to avoid. The v1 store screenshot showed such a column; it was a mock, and the v2 screenshot no longer shows it.
- **No Bot Score column in the analyzer.** Bot-scan scores are computed in memory during a scan and never written to storage, so there is nothing honest to join against. (Storing scores is possible future work.)
- **No "Most followers" sort.** Same reason as the Followers column — the field does not exist in the loaded data.
- Unfollow delays, pacing, retry/backoff and all Instagram request code are unchanged.

## 1.0.0 — 2026-08
- Initial Chrome Web Store release: non-followers analyzer, safe unfollow flow with whitelist, bot scan, free/premium plans.
