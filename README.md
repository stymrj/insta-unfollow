# Insta Unfollow

Instagram follower analysis for Chrome: see who is not following you back, scan for bot
and throwaway accounts, and unfollow safely — all from one extension.

## Features

- **Follower analysis** — who follows you, who does not, with one click
- **Bot scan** — every follower is scored on how likely it is to be a bot, with the
  reasons behind each score (no photo, no posts, generated-looking username, one-way
  follow ratio)
- **Safe unfollowing** — respectful delays and progress tracking to avoid throttling
- **Google sign-in** — premium membership is verified with a signed token from the
  payment worker; hand-edited storage does not count
- **Admin console** — the owner account can list every registered user and control
  memberships: grant premium (7/30/365 days), revoke, ban, unban or delete

## Structure

| File | Purpose |
| --- | --- |
| `popup.html` / `popup.js` / `popup.css` | Popup UI |
| `analyzer.html` / `analyzer.js` | Follower analysis page |
| `bot-scan.html` / `bot-scan.js` | Bot scan page |
| `admin.html` / `admin.js` | Admin console page |
| `theme.css` | Paper & ink editorial theme overrides (loaded last on every page) |
| `background.js` | Service worker: Google OAuth, membership resolution, UA broker |
| `premium-config.js` | Public config: worker URL, public key, admin email |
| `payments-worker.js` | Backend for Cloudflare Workers: payment links, user registry, admin API |
| `content.css` / `bot-scan.css` / `premium-modal.css` | Base styles |

## Setup

1. Load the folder as an unpacked extension in Chrome (`chrome://extensions` →
   Developer mode → Load unpacked).
2. Deploy `payments-worker.js` to Cloudflare Workers with a `PAYMENTS_KV` KV binding
   and the env vars described at the top of the file (`ADMIN_EMAIL`,
   `SIGN_PRIVATE_KEY`, optional `PAYTM_MONTHLY_URL` / `PAYTM_YEARLY_URL` for fixed
   Paytm payment links).
3. Set `PAYMENT_API_URL` in `premium-config.js` to your worker URL.
4. `PREMIUM_BY_DEFAULT = true` keeps everyone premium until selling starts; flip it to
   `false` once the worker is live and payments are on.

## Admin console

Open the Admin entry from the popup menu (shown only for the owner email). Login uses
the same Google sign-in; the worker exchanges the Google token for a one-hour signed
admin session and must have `ADMIN_EMAIL` set to your account.
