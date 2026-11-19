# Worker redeploy — Insta Unfollow payment backend (v2.0.0 fixes)

The extension fixes in 2.0.0 ship with the Chrome Web Store update, but the
worker fixes (pricing, expiry, webhook, auth, admin) only take effect AFTER
you redeploy the worker. The live worker at
`https://insta-unfollows.satyam-raj.workers.dev` is still running the old code
until then.

## What changed in the worker (payments-worker.js)

- **Pricing fixed:** Razorpay amounts are in paise — monthly is now `19900`
  (₹199) and yearly `149900` (₹1,499). The old code sent `199`/`1499`, i.e.
  ₹1.99 / ₹14.99.
- **Premium expiry anchored to payment:** the first time a paid link is seen,
  the worker records `paidAt` and `expiresAt` (30 days monthly, 365 days
  yearly). Later status checks sign the token with that same expiry — premium
  no longer renews itself forever.
- **Dead links are never reused:** an expired/cancelled Razorpay link now
  produces a fresh link instead of being handed back to the user.
- **Razorpay webhook:** `POST /webhook/razorpay` marks a payment paid the
  moment Razorpay reports it, so premium activates even if the user closed
  the payment tab. Polling via `/status` remains as a fallback.
- **Auth on `/create-link` and `/register`:** both now require a Google
  access token whose user id matches the request.
- **Admin:** membership is expiry-aware, the user list pages past the first
  500, grants store the real plan, revoke keeps the payment record (marked
  revoked), and `/admin/users` returns plan / paid date / expiry / revoked /
  link status.

## Redeploy steps

1. From the repo root on branch `v2` (after merging `v2` → `main` if that is
   how you publish):
   ```sh
   npx wrangler deploy
   ```
   This deploys `payments-worker.js` with the existing KV binding
   (`PAYMENTS_KV`). No new KV namespace is needed. Do NOT change the worker
   name or route — the extension already points at
   `https://insta-unfollows.satyam-raj.workers.dev`.
2. Set the webhook secret in the Cloudflare dashboard:
   Cloudflare dashboard → Workers & Pages → `insta-unfollow` → Settings →
   Variables → add variable `RAZORPAY_WEBHOOK_SECRET`.
   The value is the webhook secret from Razorpay Dashboard → Settings →
   Webhooks (create the webhook there first if there is none — see step 3).
   Existing variables must stay as they are: `RAZORPAY_KEY_ID`,
   `RAZORPAY_KEY_SECRET`, `SIGN_PRIVATE_KEY`, `ADMIN_EMAIL`.
3. Register the webhook in Razorpay: Razorpay Dashboard → Settings →
   Webhooks → Add New Webhook → URL
   `https://insta-unfollows.satyam-raj.workers.dev/webhook/razorpay`,
   enable the `payment_link.paid` event (alert email optional), and copy the
   webhook secret into the Cloudflare variable from step 2. A webhook with a
   wrong or missing secret is rejected with 401 and the payment is NOT marked
   paid — polling still covers it, but fix the secret promptly.
4. Redeploy once more after setting the variable if the dashboard asks
   (variable changes usually apply on the next deploy).

## How to verify

1. `curl https://insta-unfollows.satyam-raj.workers.dev/health` →
   `{"ok":true}`.
2. In the Razorpay dashboard, create a test-mode payment link (or use the
   extension's Subscribe button with a test key) and pay it in test mode.
   Then open the extension and confirm Premium activates and shows an expiry
   date ("Premium until …"). In the admin console, confirm the user shows the
   plan, paid date and days-left.
3. Check the worker logs (Cloudflare dashboard → the worker → Logs) for a
   `payment_link.paid` webhook hit after a test payment.
4. Confirm a revoked test user loses Premium on the next popup open (the
   background script now asks the worker on every login/status check).

## Notes

- Old paid records without an `expiresAt` get their expiry anchored to their
  stored `paidAt` (or to first sighting after the redeploy). If a user paid
  long ago, their premium may now correctly show as expired — that is the
  fix working, not a regression. Re-grant from the admin console if a
  long-standing paying user is affected.
- The extension's Subscribe flow now polls for up to 5 minutes after the
  payment tab opens. If a user pays after that window, premium still activates
  on the next popup open.
- Server-side free limits were deliberately NOT added in this pass: enforcing
  them from the worker touches the analyzer's scan flow and could break
  analysis. Free limits remain enforced locally in the extension as before.
