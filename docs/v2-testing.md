# Testing v2.0.0 locally (branch `v2`)

Load the branch unpacked — nothing here publishes anything.

## Load it

1. `git checkout v2` in your local clone (or use the copy at `/tmp/insta-unfollow-v2`).
2. Open Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick the repo folder.
3. The popup, analyzer, bot scan and admin pages all run from the unpacked copy. Note: an unpacked install gets its own extension ID, so it has **separate storage** from the store version — no snapshots, whitelist or cached analysis carry over. Sign in with Google again in the unpacked copy; membership is re-checked from the server, but analysis history starts empty, so run one fresh analysis before checking the Last Analysis card and the trend line.

## What to click

| # | Check | How |
|---|-------|-----|
| 1 | New look | Open the popup and the analyzer. Background should be white / very light grey with pink-purple gradient primary buttons, 12px rounded cards, Inter font — no beige, no serif headings. |
| 2 | Last Analysis card | After one analysis, the popup home tab shows a "Last analysis" card (followers / following / not-following / scan date). "View results" opens the analyzer. Before any analysis, the card is hidden. |
| 3 | Analyzer search | In the analyzer table toolbar, type part of a username or full name — the list filters as you type. Clear it to get the full list back. |
| 4 | Analyzer sort | Sort dropdown: "Username A–Z" reorders alphabetically; "Not following first" puts non-followers on top. ("Most followers" is intentionally absent — Instagram's list data has no follower counts.) |
| 5 | Filter chips | All / Not following back / Following back / Whitelisted — each filters the table; pagination still works (100 rows per page). The "Show only non-followers" switch still works alongside them. |
| 6 | Export CSV | With any filter active, click **Export CSV** — a `insta-unfollow-nonfollowers.csv` downloads with username, full name, verified, following-you, whitelisted for the filtered rows only. |
| 7 | Copy usernames | Click **Copy usernames** — a toast says "N usernames copied"; paste into a text editor to confirm. |
| 8 | Trend line | Under the "Not following back" stat card, after a **second** analysis you should see e.g. "+7 since last analysis · 4 Nov 2026" (real numbers from your stored snapshot, never hardcoded). On the first analysis after upgrading, no trend line shows until a previous snapshot exists. |
| 9 | Pricing | Popup → Upgrade tab: Premium monthly shows $25 → **$6.99, 72% OFF**; banner says "Save 72%". Yearly $129.99 → $74.99, 42% OFF. Free plan reads "40 analyses on day 1 (+20/day)". |
| 10 | No fake numbers | The Upgrade tab and the premium modal show a "Your data stays on your device" note. There must be **no** "10,000+ Active Users", **no** "4.8/5 Rating", and **no** "150 people upgraded in the last 24h" anywhere. |
| 11 | Bot scan export | Run a bot scan (or open it from a cached scan), then click **Export flagged CSV** next to "Run deep checks" — a `insta-unfollow-flagged.csv` downloads with the flagged rows and their scores/reasons. |
| 12 | No Turkish leftovers | Search the UI for "gün" or "Sonraki" — there should be none. Countdown during unfollowing reads "Next: 84s". |

## What NOT to test

- **Do not bulk-unfollow on your real account to "test" v2.** The unfollow flow, delays and pacing are unchanged from v1, but every unfollow is real. If you want to check the unfollow buttons, unfollow at most 1–2 accounts you genuinely want gone, and watch the countdown ("Next: …s") behave.
- **Do not test the payment flow with a real card** unless you intend to buy Premium. The prices shown are the live ones; a test purchase is a real purchase.
- **Do not publish from this branch.** Publishing is a manual dashboard upload of the zip (see `STORE.md` → v2.0.0 publish checklist). Verify the Store ID mismatch note at the top of `STORE.md` first.

## If something looks wrong

- Popup/analyzer still beige: you loaded the store build or an old unpacked copy — remove it and load the `v2` folder again, then hard-reload the analyzer tab.
- "Last analysis" card missing after an analysis: it only appears after a **fresh** analysis saves a snapshot (loading from cache does not rewrite it). Run one fresh analysis.
- Trend line shows the wrong comparison: it compares with your last saved snapshot. If you only ever ran one analysis, there is nothing to compare with — that is correct behaviour.
