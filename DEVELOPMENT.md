# Insta Unfollow — Development Guide (v2.0.0, branch `v2`)

Everything a developer needs to run, test, and ship this extension. No secrets
in this file — keys and tokens live only as Cloudflare worker env vars and in
the developer's own accounts, never in the repo.

## What this is

Chrome extension (Manifest V3) that reads a user's own Instagram followers and
following lists, shows who doesn't follow back, scans for bot/fake accounts,
and unfollows accounts the user chooses. Design: "Colourful bold" (navy header,
amber rule, solid indigo — no gradients). Version 2.0.0 lives on branch `v2`;
`main` still serves v1.0.0 until `v2` is merged.

## Quick start (load unpacked)

1. `chrome://extensions` → Developer mode on → **Load unpacked** → this repo root.
2. Sign in with Google in the popup, then sign in to Instagram in the browser.
3. Click **Analyse** in the popup. An unpacked install has separate storage, so
   run one fresh analysis before the Last Analysis card and trend line appear.
4. Do NOT bulk-unfollow on a real account while testing. Do NOT test-buy Premium
   with real money — use the proof flow below with a test screenshot and approve
   it yourself in the admin console, then revoke it.

## File map

| File | What it does |
|---|---|
| `popup.html` / `popup.js` | Popup: sign-in, Instagram status, Last Analysis card, plan picker, Subscribe |
| `analyzer.html` / `analyzer.js` | Analyzer: search, sort, filter chips, Export CSV, Copy usernames, unfollow |
| `bot-scan.html` / `bot-scan.js` | Bot/fake follower scan, Export flagged CSV |
| `premium.js` + `premium-modal.css` | Shared premium modal (five plan cards, UPI view, proof form) |
| `premium-config.js` | Shared config: `PREMIUM_PLANS`, UPI ID, `pollPremiumActivation`, token verify |
| `background.js` | Google sign-in, login status, membership (asks the worker first) |
| `admin.html` / `admin.js` | Admin console: users, memberships, pending payment proofs |
| `payments-worker.js` | Cloudflare Worker: plans, payment links, proofs, admin API, token signing |
| `img/paytm-qr.jpg` | The owner's static UPI QR (UPI ID `paytmqr69wd1y@ptys`) |
| `store-assets/` | Store listing images (5 screenshots 1280×800, promo, marquee) + `description.txt` |
| `docs/v2-testing.md` | 12-step test checklist for a release |
| `docs/worker-deploy.md` | Worker redeploy + verify steps |

## Pricing (final — single source of truth)

| Plan | Price | Per month | Save vs monthly | Days |
|---|---|---|---|---|
| 1 month | ₹49 | ₹49/mo | — | 30 |
| 3 months | ₹129 | ₹43/mo | ₹18 | 90 |
| 6 months | ₹249 | ₹42/mo | ₹45 | 180 |
| 9 months | ₹399 | ₹44/mo | ₹42 | 270 |
| 12 months | ₹499 | ₹42/mo | ₹89 | 365 |

Worker plan keys: `1mo`, `3mo`, `6mo`, `9mo`, `12mo`. Amounts are stored in
paise in the worker (4900 / 12900 / 24900 / 39900 / 49900). One known quirk,
kept deliberately: the 9-month per-month rate (₹44) is slightly above the
6-month rate (₹42).

## Payment flow (UPI only — no Razorpay, no Paytm links)

1. User picks a plan in the premium modal or the popup picker.
2. UPI view shows the static QR (`img/paytm-qr.jpg`), the UPI ID with a Copy
   button, and an "Open UPI app" deep link with the plan amount prefilled.
   The QR itself carries no amount — the user enters the plan amount when
   scanning it directly. Any UPI app works (GPay, PhonePe, Paytm, BHIM).
3. After paying, the user submits proof: payment screenshot (required,
   downscaled in-browser, 500 KB cap) + UTR/transaction reference (optional).
   `POST /submit-proof` (Google-token authenticated, one pending proof per
   user + plan).
4. The owner reviews the proof in the admin console (Pending payments queue:
   screenshot, UTR, plan, user) and Approves or Rejects it. Approve grants
   premium for the plan's days, anchored to approval time; it never shortens
   an existing grant.
5. The extension polls `/status` and activates Premium with an expiry date
   ("Premium until …"). A pending proof shows "Payment under review".

Why no Paytm links: Paytm dashboard payment links expire after max 3 days, so
fixed links would die constantly. Razorpay code is still in the worker but
dormant (no keys configured) and is not part of this flow.

## Admin console

Open `admin.html` from the extension (Admin menu item, visible only to the
account in `PREMIUM_ADMIN_EMAIL`). It lists users (search, pagination past
500 users works), membership with plan / paid date / days-left, and the pending
payment proofs queue. Grant = 1/3/6/9/12 months (+ 7-day trial); Revoke keeps
the payment record (marked revoked) instead of deleting it; Ban blocks the
account; Delete removes every record. Admin sessions last 1 hour.

## Worker (Cloudflare)

`payments-worker.js` is NOT in the store zip — it is deployed separately.

- Env vars that must be set: `SIGN_PRIVATE_KEY` (Ed25519 seed hex),
  `ADMIN_EMAIL`. Razorpay vars (`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`,
  `RAZORPAY_WEBHOOK_SECRET`) are dormant/unused for the UPI flow.
- KV binding `PAYMENTS_KV` (see `wrangler.toml`).
- Deploy: `npx wrangler deploy` from the repo root, then verify:
  `curl https://insta-unfollows.satyam-raj.workers.dev/health` →
  `{"ok":true}`, and `/payment-methods` →
  `{"paytm":false,"upi":true,"razorpay":false}`.
- Key endpoints: `POST /register`, `POST /create-link`,
  `GET /status?u=<googleId>&email=<email>`, `GET /payment-methods`,
  `POST /submit-proof`, `GET /admin/proofs`, `POST /admin/proofs/<id>/approve|reject`,
  `POST /webhook/razorpay` (dormant without the webhook secret).
- The live worker still runs old code until it is redeployed — extension
  fixes and worker fixes go live on different schedules.

## Store release (how the zip is built)

> Unpacked test builds: `manifest.json` carries a `"key"` (public key only) that pins the
> unpacked extension id to `gpgcdajecndabpbigkblhbojakohoiil`, so Google sign-in works
> from a test build — the OAuth client has that id's `chromiumapp.org` redirect registered
> alongside the store id's. The private key lives at `~/workspace/iu-dev-key.pem`: never
> commit it, never put it in the zip. The store ignores the key on upload, so the published
> listing keeps its own id.

```sh
# Normalise permissions FIRST — the store's Linux install test extracts the
# package as one user and may load it as another, so files must be
# world-readable (644) and dirs 755. A zip built from a restrictive umask
# (660/770 entries) can fail automated installation testing.
find . -type d -exec chmod 755 {} +
find . -type f -exec chmod 644 {} +
zip -r ../insta-unfollow-v2.0.0.zip . -x ".git/*" ".env" ".gitignore" ".DS_Store" \
  "README.md" "docs/*" "screenshots/*" "store-assets/*" "wrangler.toml" \
  "payments-worker.js" "img/logo.svg" "*.zip"
```

`DEVELOPMENT.md` (this file) IS included in the zip on purpose. Listing images
come from `store-assets/` (upload them in the dashboard, they are not in the
zip). Before uploading, confirm the live listing ID in the developer dashboard
— `STORE.md` and an older dashboard screenshot disagreed about it, and the
OAuth redirect for the live store ID must be registered on the Google OAuth
client or sign-in breaks after the update. Full checklist: `STORE.md`.

## Known limitations

- Free-plan scan/unfollow limits are enforced in local extension storage only;
  there is no server-side enforcement yet.
- The store screenshots may lag the latest modal pricing — regenerate them from
  the current UI before a release if the pricing shown in them is stale.
- `README.md` still references the dormant `PAYTM_MONTHLY_URL` /
  `PAYTM_YEARLY_URL` worker vars (accurate for the dormant code, not used by
  the UPI flow).
