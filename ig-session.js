/**
 * Shared Instagram session bootstrap — viewer id, username, csrf token.
 *
 * Replaces `https://www.instagram.com/data/shared_data/`, which Instagram removed
 * (it now answers 404). That endpoint was the extension's session bootstrap: every
 * analysis, the popup's sign-in check, the bot scan and every unfollow started from
 * `config.viewer` / `config.csrf_token` there, so its removal broke Analyze with the
 * generic "An error occurred while fetching data" error before any list was read.
 *
 * What replaces it, in order:
 *   1. The Instagram homepage HTML (same fetch the old endpoint used — `credentials:
 *      include`, so it carries the user's session). A signed-in page embeds the viewer
 *      (`"viewer":{"id":"…","username":"…"}`) and a csrf token in its bootstrap JSON.
 *      A csrf token alone proves nothing — the logged-out page carries one too — so a
 *      session only counts when a viewer id is found. A failure of this fetch (dropped
 *      request, 429, 5xx) NEVER ends the attempt: the page is heavy and Instagram
 *      throttles it first, while the API endpoint below often still answers.
 *   2. `api/v1/accounts/edit/web_form_data/` (already used by background.js and popup.js):
 *      answers with the signed-in username, or 401/403 when nobody is signed in. That
 *      is what tells "signed out" apart from "Instagram is refusing us".
 *   3. If the user is signed in but the homepage hid the id, the public profile page
 *      (`instagram.com/<username>/`) embeds the same id next to the username.
 *
 * One retry: a `refused` with reason `network` or `server` is retried once after 2s —
 * a single dropped request should not kill an analysis. Rate-limit and signed-out
 * results are never retried.
 *
 * Loaded in three contexts, always before its callers:
 *   - analyzer.html and bot-scan.html (extension pages, before unfollow-bridge.js)
 *   - the Instagram tab page itself (ig-content.js injects it before unfollow-bridge.js,
 *     and it is listed in manifest web_accessible_resources for that)
 *   - popup.html (before popup.js)
 * In the tab the homepage fetch is same-origin; on extension pages it carries the
 * instagram.com session cookies exactly like the old endpoint did.
 *
 * `fetchSession()` never throws: it returns `{ status: 'ok' | 'logged_out' | 'refused',
 * reason, detail, id, username, csrfToken, profilePicUrl }`. `detail` is a plain-words
 * log of what each step did ("homepage: network error; web_form_data: 500"), so a failed
 * session can say exactly which request failed instead of a bare "temporarily unavailable".
 * Callers map 'logged_out' to the "please sign in" path and 'refused' to the rate-limit /
 * try-later path, the same three-way answer the old shared_data check gave them. Successful sessions are cached
 * for the page lifetime (the callers already cache the viewer the same way); failures
 * are not cached, so Re-analyze after signing in works without reloading the page.
 *
 * The parsers are pure functions, exported for the Node harness — see
 * ../iu-session-tests/session-parse.test.cjs (kept outside the repo, it is not shipped).
 */
(function (root) {
  'use strict';

  var IG_APP_ID = '936619743392459';
  var IG_HOME_URL = 'https://www.instagram.com/';
  var WEB_FORM_DATA_URL = 'https://www.instagram.com/api/v1/accounts/edit/web_form_data/';

  var cachedSession = null;

  function emptySession(status, reason, detail) {
    return { status: status, reason: reason || '', detail: detail || '', id: '', username: '', csrfToken: '', profilePicUrl: '' };
  }

  /**
   * Pull the viewer block and csrf token out of Instagram homepage HTML.
   *
   * The bootstrap JSON appears in two shapes: plain (`"viewer":{"id":"123"}`) and
   * JSON-escaped inside a larger string (`\"viewer\":{\"id\":\"123\"}`). The escaped
   * shape is handled by running the same plain patterns over a de-escaped copy —
   * one pattern set instead of two that can drift apart. Returns empty strings
   * when nothing is found — the caller decides what that means.
   */
  function parseViewerFromHtml(html) {
    var out = { id: '', username: '', csrfToken: '', profilePicUrl: '' };
    if (!html || typeof html !== 'string') return out;
    extractViewerInto(out, html);
    if (!out.id || !out.username || !out.csrfToken) {
      extractViewerInto(out, html.replace(/\\"/g, '"'));
    }
    return out;
  }

  function extractViewerInto(out, text) {
    // csrf token: anywhere in the page.
    var csrf = text.match(/"csrf_token"\s*:\s*"([^"]+)"/);
    if (csrf && !out.csrfToken) out.csrfToken = csrf[1];

    // The viewer object: grab the block, then read its flat fields out of it.
    var block = text.match(/"viewer"\s*:\s*\{[^}]{0,3000}/);
    if (block) {
      var b = block[0];
      var id = b.match(/"id"\s*:\s*"(\d+)"/) || b.match(/"id"\s*:\s*(\d+)/);
      var username = b.match(/"username"\s*:\s*"([^"]+)"/);
      var pic = b.match(/"profile_pic_url"\s*:\s*"([^"]+)"/);
      if (id && !out.id) out.id = id[1];
      if (username && !out.username) out.username = username[1];
      if (pic && !out.profilePicUrl) out.profilePicUrl = pic[1].replace(/\\u0026/g, '&');
    }

    // Fallback: some pages carry the id on its own key instead of inside viewer.
    if (!out.id) {
      var viewerId = text.match(/"viewer_id"\s*:\s*"(\d+)"/) || text.match(/"viewer_id"\s*:\s*(\d+)/);
      if (viewerId) out.id = viewerId[1];
    }
  }

  /**
   * Pull the numeric id for `username` out of that account's public profile page HTML,
   * where the id sits next to the username in the embedded user object.
   */
  function parseProfileIdFromHtml(html, username) {
    if (!html || typeof html !== 'string' || !username) return '';
    var esc = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var m = html.match(new RegExp('"id"\\s*:\\s*"(\\d+)"[^}]{0,500}"username"\\s*:\\s*"' + esc + '"'))
      || html.match(new RegExp('"username"\\s*:\\s*"' + esc + '"[^}]{0,500}"id"\\s*:\\s*"(\\d+)"'));
    if (m) return m[1];
    // Same search over a de-escaped copy, for profile pages whose JSON is escaped.
    var flat = html.replace(/\\"/g, '"');
    m = flat.match(new RegExp('"id"\\s*:\\s*"(\\d+)"[^}]{0,500}"username"\\s*:\\s*"' + esc + '"'))
      || flat.match(new RegExp('"username"\\s*:\\s*"' + esc + '"[^}]{0,500}"id"\\s*:\\s*"(\\d+)"'));
    return m ? m[1] : '';
  }

  /** web_form_data answers `{ form_data: { username, ... } }`; the id is read too if present. */
  function parseWebFormData(data) {
    var form = (data && data.form_data) || {};
    return {
      username: typeof form.username === 'string' ? form.username : '',
      id: form.id != null ? String(form.id) : ''
    };
  }

  async function fetchSessionUncached() {
    // Every step records what happened, in plain words, so a failed session can say
    // exactly which request failed and how — "temporarily unavailable" on its own
    // tells nobody whether the homepage dropped, the API refused, or the profile page
    // hid the id. The detail travels out on the session object (see fetchSession).
    var steps = [];
    function step(name, outcome) { steps.push(name + ': ' + outcome); }
    function detail() { return steps.join('; '); }

    // 1. The homepage: the only source that carries id + username + csrf in one shot.
    // A failure here NEVER ends the attempt — the page is heavy and Instagram throttles
    // or drops it first, while the lightweight API endpoint below often still answers.
    // (Returning refused on a homepage network error was the 2.0.1 bug: one dropped
    // request killed Analyze with "temporarily unavailable" before web_form_data ran.)
    var homeFailed = '';
    var homeHtml = '';
    try {
      var home = await fetch(IG_HOME_URL, { credentials: 'include' });
      if (home.status === 429) { homeFailed = 'rate_limit'; step('homepage', '429'); }
      else if (home.status >= 500) { homeFailed = 'server'; step('homepage', String(home.status)); }
      else if (home.ok) { homeHtml = await home.text(); step('homepage', 'ok, no viewer'); }
      else { homeFailed = 'unknown'; step('homepage', String(home.status)); }
    } catch (e) {
      homeFailed = 'network';
      step('homepage', 'network error');
    }

    var parsed = parseViewerFromHtml(homeHtml);
    if (parsed.id) {
      return {
        status: 'ok', reason: '', detail: detail(), id: parsed.id, username: parsed.username,
        csrfToken: parsed.csrfToken, profilePicUrl: parsed.profilePicUrl
      };
    }

    // 2. web_form_data: the lightweight API endpoint; also the sign-in oracle. Its
    // 401/403 is the one definitive "nobody is signed in" — it overrides a throttled
    // homepage, which cannot tell a signed-out browser from a throttled one.
    var form = { username: '', id: '' };
    try {
      var res = await fetch(WEB_FORM_DATA_URL, {
        credentials: 'include',
        headers: { 'x-ig-app-id': IG_APP_ID, 'x-requested-with': 'XMLHttpRequest' }
      });
      if (res.status === 401 || res.status === 403) {
        step('web_form_data', String(res.status));
        return emptySession('logged_out', 'expired', detail());
      }
      if (res.status === 429) {
        step('web_form_data', '429');
        return emptySession('refused', 'rate_limit', detail());
      }
      if (res.status >= 500) {
        step('web_form_data', String(res.status));
        return emptySession('refused', homeFailed === 'rate_limit' ? 'rate_limit' : 'server', detail());
      }
      if (res.ok) {
        var data = await res.json().catch(function () { return null; });
        form = parseWebFormData(data);
        step('web_form_data', form.username ? 'signed in as @' + form.username : 'ok, no username');
      } else {
        step('web_form_data', String(res.status));
      }
    } catch (e) {
      step('web_form_data', 'network error');
      return emptySession('refused', homeFailed === 'rate_limit' ? 'rate_limit' : 'network', detail());
    }

    if (form.id) {
      return {
        status: 'ok', reason: '', detail: detail(), id: form.id, username: form.username,
        csrfToken: parsed.csrfToken, profilePicUrl: ''
      };
    }
    if (!form.username) {
      // No viewer in the homepage and the API answered without a username: logged out.
      return emptySession('logged_out', 'expired', detail());
    }

    // 3. Signed in, but the homepage hid the id: read it off the public profile page.
    // Two attempts: this page is HTML like the homepage, so a single dropped request
    // should not turn a proven signed-in session into "unavailable".
    for (var attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise(function (resolve) { setTimeout(resolve, 1500); });
      try {
        var prof = await fetch(IG_HOME_URL + encodeURIComponent(form.username) + '/', { credentials: 'include' });
        if (prof.status === 429) {
          step('profile page', '429');
          return emptySession('refused', 'rate_limit', detail());
        }
        if (prof.ok) {
          var id = parseProfileIdFromHtml(await prof.text(), form.username);
          if (id) {
            step('profile page', 'ok');
            return {
              status: 'ok', reason: '', detail: detail(), id: id, username: form.username,
              csrfToken: parsed.csrfToken, profilePicUrl: ''
            };
          }
          step('profile page', 'ok, no id found');
        } else {
          step('profile page', String(prof.status));
        }
      } catch (e) {
        step('profile page', 'network error');
      }
    }
    return emptySession('refused', 'unknown', detail());
  }
  async function fetchSession() {
    if (cachedSession && cachedSession.status === 'ok') return cachedSession;
    var session = await fetchSessionUncached();
    if (session.status === 'refused' && (session.reason === 'network' || session.reason === 'server')) {
      // One retry: a single dropped request or a hiccuping endpoint should not kill the
      // analysis. Never retried: rate_limit (retrying makes throttling longer),
      // logged_out, and unknown (the page shapes will not change in 2 seconds).
      await new Promise(function (resolve) { setTimeout(resolve, 2000); });
      session = await fetchSessionUncached();
    }
    if (session.status === 'ok') cachedSession = session;
    return session;
  }

  root.IgSession = {
    fetchSession: fetchSession,
    parseViewerFromHtml: parseViewerFromHtml,
    parseProfileIdFromHtml: parseProfileIdFromHtml,
    parseWebFormData: parseWebFormData,
    // Test-only: the Node harness resets the page-lifetime cache between scenarios.
    _resetCache: function () { cachedSession = null; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
