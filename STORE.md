# Chrome Web Store — Insta Unfollow

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