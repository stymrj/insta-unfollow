# Worker redeploy — Insta Unfollow payment backend (v2.0.0, manual payments)

The extension fixes in 2.0.0 ship with the Chrome Web Store update, but the
worker fixes (pricing, expiry, manual payments, auth, admin) only take effect
AFTER you redeploy the worker. The live worker at
`https://insta-unfollows.satyam-raj.workers.dev` is still running the old code
until then.

## How payments work now (manual payments)

Users pay **outside** the extension and prove it — there is no automatic
payment verification any more:

1. **UPI** — the user pays your UPI ID (QR code, copy-UPI-ID, or a UPI app
   deep link, all offline in the extension) and uploads a screenshot of the
   payment, with the UTR/reference number if they have one. Any UPI app
   works — GPay, PhonePe, Paytm, BHIM — since they all scan the same UPI QR.
2. There is NO Paytm payment-link option: Paytm dashboard links expire after
   a maximum of 3 days, so a static link per plan would die in 3 days and
   need regenerating + a worker redeploy every 3 days. Users who prefer
   Paytm simply pay with the Paytm app by scanning the same UPI QR.
3. The screenshot proof sits in a **pending** state until you review it in
   the admin console: **Approve** grants Premium for the plan's duration
   (30 days for 1 month, 90 days for 3 months, 180 days for 6 months,
   270 days for 9 months, 365 days for 12 months), **Reject** lets the
   user submit a new proof.

Manual payments need **no webhook and no Razorpay keys**. Razorpay stays
dormant: the old webhook code (`POST /webhook/razorpay`, HMAC-verified
against `RAZORPAY_WEBHOOK_SECRET`) still exists in the worker, but it is
unused without Razorpay keys set, and the
`RAZORPAY_WEBHOOK_SECRET` step below no longer applies to this flow.

## What changed in the worker (payments-worker.js)

- **Pricing fixed:** Razorpay amounts are in paise — 1 month `4900`
  (₹49), 3 months `12900` (₹129), 6 months `24900` (₹249), 9 months
  `39900` (₹399), 12 months `49900` (₹499). The old code sent `199`/`1499`, i.e.
  ₹1.99 / ₹14.99.
- **Premium expiry anchored to payment:** the first time a paid link is seen,
  the worker records `paidAt` and `expiresAt` (30 days for 1 month, 90 days
  for 3 months, 180 days for 6 months, 270 days for 9 months, 365 days for
  12 months). Later status checks sign the token with that same expiry — premium
  no longer renews itself forever.
- **Dead links are never reused:** an expired/cancelled Razorpay link now
  produces a fresh link instead of being handed back to the user.
- **Manual payments:** `GET /payment-methods` reports UPI as the only live
  method (`{paytm:false, upi:true, razorpay:false}`). Screenshot proofs are stored pending review:
  `GET /admin/proofs?status=pending`, `GET /admin/proofs/<id>` (includes the
  screenshot), `POST /admin/proofs/<id>/approve` (grants 30 / 90 / 180 / 270 /
  365 days by plan),
  `POST /admin/proofs/<id>/reject` (optional `{reason}`; the user may
  resubmit). There is no Paytm-link option any more (see below) and no
  Razorpay keys, so nothing is auto-verified — premium activates only from
  the admin console after you confirm the payment.
- **Auth on `/create-link` and `/register`:** both now require a Google
  access token whose user id matches the request.
- **Admin:** membership is expiry-aware, the user list pages past the first
  500, grants store the real plan, revoke keeps the payment record (marked
  revoked), and `/admin/users` returns plan / paid date / expiry / revoked /
  link status.

## Redeploy steps

1. From the repo root on branch `v2` (after merging `v2` → `main` yourself,
   if that is how you publish):
   ```sh
   npx wrangler deploy
   ```
   This deploys `payments-worker.js` with the existing KV binding
   (`PAYMENTS_KV`). No new KV namespace is needed. Do NOT change the worker
   name (`insta-unfollow`) or route — the extension already points at
   `https://insta-unfollows.satyam-raj.workers.dev`.
2. Set the worker variables in the Cloudflare dashboard:
   Cloudflare dashboard → Workers & Pages → `insta-unfollow` → Settings →
   Variables. Redeploy once more after setting variables if the dashboard
   asks (variable changes usually apply on the next deploy).

## Environment variables

### Needed for manual payments

| Variable | What it is |
|---|---|
| `SIGN_PRIVATE_KEY` | The Ed25519 private seed hex (32 bytes) — the worker still needs this to sign premium tokens. Keep the existing value. |
| `ADMIN_EMAIL` | The Google email that runs the admin console. Keep the existing value. |

No Paytm variables are needed — see "Why there is no Paytm-link option" below.

### NOT needed for manual payments

| Variable | Status |
|---|---|
| `RAZORPAY_KEY_ID` | Not needed for manual payments. Leave unset (or leave the old value in place — it is simply unused). |
| `RAZORPAY_KEY_SECRET` | Not needed for manual payments. Same as above. |
| `RAZORPAY_WEBHOOK_SECRET` | No longer applies to this flow — the webhook code exists but is unused without Razorpay keys. Do not register a Razorpay webhook for manual payments. |

## Why there is no Paytm-link option

Paytm dashboard payment links have a maximum validity of **3 days**. A static
link per plan would die in 3 days and need regenerating + a worker redeploy
every 3 days, so the fixed-Paytm-link option was dropped from the build
(2026-11-19). **Do not create Paytm payment links — none are needed.**

Payment is UPI only: the user scans the same UPI QR with any UPI app
(GPay, PhonePe, Paytm, BHIM) and uploads a screenshot proof. The worker's old
fixed-link fallback code (`PAYTM_MONTHLY_URL` / `PAYTM_YEARLY_URL` path in
`/create-link`) is still in `payments-worker.js`, dormant and untouched —
nothing in the new flow calls it. If on-demand Paytm checkout is ever wanted,
the worker would need to create links via the Paytm API with a MID + merchant
key instead — that is not built.

## UPI — set your UPI ID

1. In `premium-config.js`, `window.UPI_ID` is already set to the real UPI ID
   from the owner's Paytm QR (`paytmqr69wd1y@ptys`, payee `Satyam Raj`) — do
   not change it unless the receiving UPI ID changes. The extension shows the
   static QR image `img/paytm-qr.jpg` (the owner's own Paytm QR), plus a
   copy-UPI-ID button and a UPI-app deep link built from this one value.
   The QR itself carries no amount, so the UI tells the user to enter the plan
   amount (₹49 for 1 month, ₹129 for 3 months, ₹249 for 6 months, ₹399
   for 9 months, ₹499 for 12 months) when scanning it; the deep link
   prefills it.
2. No UPI ID is set on the worker and none belongs in any env var — the
   worker never sees the UPI payment itself; it only stores the screenshot
   proof the user uploads.
4. After changing `premium-config.js`, ship it with the next extension
   update (it is extension code, not worker code, so `npx wrangler deploy`
   does not pick it up).

## Admin — approve / reject payments

1. Open the admin console in the extension (signed in as `ADMIN_EMAIL`).
2. The **Pending payments** section sits above the user table and lists every
   proof awaiting review: name + email, plan (1 month ₹49 / 3 months ₹129 /
   6 months ₹249 / 9 months ₹399 / 12 months ₹499),
   method (UPI — a user who paid with the Paytm app still shows as UPI, since
   they scan the same UPI QR), UTR (or `—` when the user left it blank), and when
   it was submitted.
3. **View** opens the proof's payment screenshot in a new tab (and shows the
   proof's details). Check the screenshot against the plan amount and the
   UTR before deciding.
4. **Approve** asks for confirmation ("Approve this payment and grant
   <plan> Premium to <email>?") and then grants Premium — 30 days for
   1 month, 90 days for 3 months, 180 days for 6 months, 270 days for
   9 months, 365 days for 12 months, counted from approval. The proof leaves the
   pending list and the user shows as Premium.
5. **Reject** asks for confirmation ("Reject this payment? The user can
   submit a new proof.") and then asks for an optional reason, which is
   passed to the worker as `{reason}`. The user can submit a new proof
   afterwards.

## How to verify

1. `curl https://insta-unfollows.satyam-raj.workers.dev/health` →
   `{"ok":true}`.
2. `curl https://insta-unfollows.satyam-raj.workers.dev/payment-methods` →
   `{"paytm":false,"upi":true,"razorpay":false}` — UPI is the only live method.
3. Submit a test proof from the extension: pay via UPI with any UPI app
   (GPay, PhonePe, Paytm, BHIM), upload a screenshot, add a UTR. Confirm it appears in the admin
   console under **Pending payments** with the right plan, method and UTR.
4. In the admin console, **View** the proof (screenshot opens in a new tab),
   then **Approve** it. Confirm the proof leaves the pending list and the
   user shows as Premium with the right expiry (30 days for 1 month,
   90 days for 3 months, 180 days for 6 months, 270 days for 9 months,
   365 days for 12 months).
5. Confirm the user side: open the extension and check `GET /status`
   returns premium for that user (popup shows Premium with an expiry date,
   e.g. "Premium until …"). Also confirm a **Reject** on a second test proof
   removes it from pending and lets that user submit a new proof.
6. Check the worker logs (Cloudflare dashboard → the worker → Logs) if any
   step above fails — proof submissions and admin approve/reject calls are
   logged there.

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
