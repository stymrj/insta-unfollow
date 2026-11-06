# Chrome Web Store — Insta Unfollow

> ⚠️ **STORE ID MISMATCH — VERIFY BEFORE PUBLISHING v2.**
> This file says the store ID is `gemhambjlinaackpaifgpgcmbbckmbnf`, but the
> dashboard screenshot Satyam shared on 2026-11-06 shows the live listing as
> `kdlobnohhjkneflmopckfidfekdkokcd`. These may be two different listings (or
> one of them may be stale). **Do not upload the v2 zip until you have confirmed
> which ID is the live public listing** (dashboard → the listing whose stats
> show 135 page views / 2.45k impressions in the last 30 days). If the live ID
> is `kdlobnohhjkneflmopckfidfekdkokcd`, the OAuth redirect below is also
> wrong for it — Google sign-in needs
> `https://kdlobnohhjkneflmopckfidfekdkokcd.chromiumapp.org/` registered on the
> OAuth client, or sign-in will fail for users after the update. Update the
> "Item details" and "OAuth" sections below once verified.

Everything needed to publish a new version.

## Item details

- **Store ID:** `gemhambjlinaackpaifgpgcmbbckmbnf`
- **Store URL:** https://chromewebstore.google.com/detail/gemhambjlinaackpaifgpgcmbbckmbnf
- **Privacy policy:** https://stymrj.github.io/insta-unfollow/privacy.html
- **Homepage / Support:** https://github.com/stymrj/insta-unfollow
- **Dev extension ID:** `ajlpgmeldhjmemkagchcejcipekhjpcc`

## OAuth (critical — Google sign-in)

OAuth client: `483666926131-ho9r406mnt14ssnlv25nv108fbpmj5s0.apps.googleusercontent.com`

Authorized redirect URIs that must ALL be registered (Google Cloud Console → OAuth 2.0 Client IDs → the client above):

- `https://ajlpgmeldhjmemkagchcejcipekhjpcc.chromiumapp.org/` (local dev copy)
- `https://gemhambjlinaackpaifgpgcmbbckmbnf.chromiumapp.org/` (store version)

Client status must be **Production** (not Testing), or sign-in fails for users.

## Publishing a new version

1. Edit code, bump `version` in `manifest.json` (store rejects duplicate versions).
2. Reload the dev extension (`chrome://extensions` → Reload) and test.
3. Build the zip, excluding dev/server files:
   ```sh
   zip -r ../insta-unfollow.zip . -x ".git/*" ".env" ".gitignore" ".DS_Store" \
     "README.md" "docs/*" "screenshots/*" "store-assets/*" "wrangler.toml" \
     "payments-worker.js" "img/logo.svg" "*.zip"
   ```
4. Upload to the Chrome Web Store dashboard → Package → new version.
5. Update screenshots in the listing if the UI changed (files in `store-assets/`).

## v2.0.0 publish checklist

Branch: `v2` (local only — merge to `main` after verifying, then publish from `main`).

- [x] `manifest.json` version bumped 1.0.0 → 2.0.0
- [x] Design refresh (theme.css) + all 7 store images regenerated from the new UI
      (`store-assets/`: 5 screenshots 1280×800, promo 440×280, marquee 1400×560)
- [x] `store-assets/description.txt` rewritten (keyword-rich first lines, What's New in 2.0,
      honest free/premium limits, no fake numbers)
- [x] `CHANGELOG.md` added with the 2.0.0 entry
- [x] Pricing fixed to 72% OFF monthly ($25 → $6.99) everywhere; yearly stays 42% OFF
- [x] Fake social proof removed (10,000+ users, 4.8/5 rating, "150 upgraded in last 24h")
- [ ] **Verify the live Store ID** (see the mismatch warning at the top of this file) and
      update "Item details" + the OAuth redirect list below if the live ID differs
- [ ] **Verify OAuth redirect URIs** for the live store ID on the Google Cloud Console
      (client `483666926131-ho9r406mnt14ssnlv25nv108fbpmj5s0.apps.googleusercontent.com`,
      status must be Production). Do NOT change the client ID or the worker URL.
- [ ] Load the branch unpacked and run through `docs/v2-testing.md`
- [ ] Merge `v2` → `main`, build the zip (step 3 above), upload to the dashboard
- [ ] After the store review passes, confirm the listing shows version 2.0.0 and the
      new screenshots; watch the first week for sign-in / payment complaints

## Store listing reference

- **Category:** Social & Communication
- **Summary:** Insta Unfollow: Instagram follower tracker. Find who doesn't follow back on Instagram and unfollow them to clean your list.
- **Description:** see `store-assets/description.txt`
- **Privacy tab answers:** single purpose + all permission justifications are in `store-assets/privacy-form.txt`
- **Data usage checkboxes:** Personally identifiable information only; all three certification boxes checked.
- **Remote code:** No.

## Assets (in store-assets/)

- `screenshot-1-analyzer.png` … `screenshot-5-admin.png` — 1280×800, 24-bit RGB PNG
- `promo-440x280.png` — small promo tile
- `marquee-1400x560.png` — marquee promo tile
- `icon-128.png` — store icon (copy of `img/128.png`)

All store assets regenerate from `screenshots/` (gitignored) or the extension itself. The marquee/screenshots HTML sources are in the temp harness used to produce them; if they need re-creation, they can be rebuilt from the extension UI.