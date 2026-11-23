/**
 * Shared Instagram session bootstrap — viewer id, username, csrf token, profile info.
 *
 * Designed to mirror official Instagram Web client and top-performing competitor:
 *   1. Reads active session from Chrome cookies (`ds_user_id`, `sessionid`, `csrftoken`).
 *      If `ds_user_id` or `sessionid` is missing, user is not logged in.
 *   2. If user is logged in, resolves profile metadata (username, counts, avatar) via:
 *      - `PolarisProfilePageContentQuery` (doc_id: 40158838120366999) on `api/graphql`
 *      - Or embedded viewer data in homepage HTML
 *      - Or `api/v1/accounts/current_user/`
 *      - Or storage cache for fast instant rendering
 *   3. Never blocks user or analysis if secondary profile info takes time to load.
 *      If cookies are valid, user is authenticated and analysis can run.
 */
(function (root) {
  'use strict';

  var IG_APP_ID = '936619743392459';
  var IG_HOME_URL = 'https://www.instagram.com/';
  var CURRENT_USER_URL = 'https://www.instagram.com/api/v1/accounts/current_user/';

  var cachedSession = null;

  // Clear any legacy rate limit lockout on script evaluation
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.remove('igSessionRateLimit');
    }
  } catch (e) {}

  // Standard Instagram headers matching web client
  function getStandardHeaders(csrfToken) {
    return {
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'X-Asbd-Id': '198387',
      'X-Ig-App-Id': IG_APP_ID,
      'X-Instagram-AJAX': '1',
      'X-CSRFToken': csrfToken || '',
      'X-Requested-With': 'XMLHttpRequest'
    };
  }

  // Read one Instagram cookie using chrome.cookies.getAll
  function getCookie(name) {
    return new Promise(function (resolve) {
      try {
        if (typeof chrome === 'undefined' || !chrome.cookies || !chrome.cookies.getAll) {
          resolve('');
          return;
        }
        var settled = false;
        function finish(val) {
          if (!settled) {
            settled = true;
            resolve(val || '');
          }
        }
        var res = chrome.cookies.getAll({ domain: 'instagram.com' }, function (cookies) {
          if ((typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError) || !cookies || !Array.isArray(cookies)) {
            if (chrome.cookies.get) {
              try {
                chrome.cookies.get({ url: IG_HOME_URL, name: name }, function (cookie) {
                  finish((cookie && cookie.value) ? String(cookie.value) : '');
                });
                return;
              } catch (e) {}
            }
            finish('');
            return;
          }
          var match = cookies.find(function (c) { return c && c.name === name; });
          finish((match && match.value) ? String(match.value) : '');
        });
        if (res && typeof res.then === 'function') {
          res.then(function (cookies) {
            if (!cookies || !Array.isArray(cookies)) { finish(''); return; }
            var match = cookies.find(function (c) { return c && c.name === name; });
            finish((match && match.value) ? String(match.value) : '');
          }).catch(function () { finish(''); });
        }
      } catch (e) {
        resolve('');
      }
    });
  }

  function emptySession(status, reason, detail) {
    return {
      status: status,
      reason: reason || '',
      detail: detail || '',
      id: '',
      username: '',
      fullName: '',
      csrfToken: '',
      profilePicUrl: '',
      followerCount: null,
      followingCount: null
    };
  }

  /**
   * Pull the viewer block and csrf token out of Instagram homepage HTML.
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
    var csrf = text.match(/"csrf_token"\s*:\s*"([^"]+)"/);
    if (csrf && !out.csrfToken) out.csrfToken = csrf[1];

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

    if (!out.id) {
      var viewerId = text.match(/"viewer_id"\s*:\s*"(\d+)"/) || text.match(/"viewer_id"\s*:\s*(\d+)/);
      if (viewerId) out.id = viewerId[1];
    }
  }

  function parseProfileIdFromHtml(html, username) {
    if (!html || typeof html !== 'string' || !username) return '';
    var esc = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var m = html.match(new RegExp('"id"\\s*:\\s*"(\\d+)"[^}]{0,500}"username"\\s*:\\s*"' + esc + '"'))
      || html.match(new RegExp('"username"\\s*:\\s*"' + esc + '"[^}]{0,500}"id"\\s*:\\s*"(\\d+)"'));
    if (m) return m[1];
    var flat = html.replace(/\\"/g, '"');
    m = flat.match(new RegExp('"id"\\s*:\\s*"(\\d+)"[^}]{0,500}"username"\\s*:\\s*"' + esc + '"'))
      || flat.match(new RegExp('"username"\\s*:\\s*"' + esc + '"[^}]{0,500}"id"\\s*:\\s*"(\\d+)"'));
    return m ? m[1] : '';
  }

  function parseUserIdFromApi(data) {
    if (!data || typeof data !== 'object') return '';
    var user = (data.user && typeof data.user === 'object') ? data.user : data;
    var id = user.pk != null ? user.pk : user.id;
    return id != null ? String(id) : '';
  }

  function parseUsernameFromApi(data) {
    if (!data || typeof data !== 'object') return '';
    var user = (data.user && typeof data.user === 'object') ? data.user : data;
    return typeof user.username === 'string' ? user.username : '';
  }

  function parseWebFormData(data) {
    var form = (data && data.form_data) || {};
    return {
      username: typeof form.username === 'string' ? form.username : '',
      id: form.id != null ? String(form.id) : ''
    };
  }

  // Helper to fetch fb_dtsg token from homepage
  var cachedFbDtsg = null;
  var cachedFbDtsgAt = 0;
  async function getFbDtsg() {
    if (cachedFbDtsg && (Date.now() - cachedFbDtsgAt < 30 * 60 * 1000)) {
      return { dtsg: cachedFbDtsg, html: '' };
    }
    try {
      var res = await fetch(IG_HOME_URL, {
        headers: { 'Accept': 'text/html' },
        credentials: 'include'
      });
      if (!res.ok) return { dtsg: null, html: '' };
      var html = await res.text();
      var match = html.match(/"DTSGInitData",\[\],\{"token":"([^"]+)"/) ||
                  html.match(/"DTSGInitialData",\[\],\{"token":"([^"]+)"/) ||
                  html.match(/name="fb_dtsg" value="([^"]+)"/);
      var token = match ? match[1] : null;
      if (token) {
        cachedFbDtsg = token;
        cachedFbDtsgAt = Date.now();
      }
      return { dtsg: token, html: html };
    } catch (e) {
      return { dtsg: null, html: '' };
    }
  }

  // Fetch full user profile using Instagram Web's official GraphQL query (PolarisProfilePageContentQuery)
  async function fetchUserProfileFromGraphql(userId, csrfToken, dtsg) {
    if (!dtsg) return null;
    try {
      var headers = getStandardHeaders(csrfToken);
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      var body = new URLSearchParams({
        fb_dtsg: dtsg,
        fb_api_req_friendly_name: 'PolarisProfilePageContentQuery',
        doc_id: '40158838120366999',
        variables: JSON.stringify({
          id: String(userId),
          enable_integrity_filters: true,
          __relay_internal__pv__PolarisCannesGuardianExperienceEnabledrelayprovider: true,
          __relay_internal__pv__PolarisCASB976ProfileEnabledrelayprovider: false,
          __relay_internal__pv__PolarisWebSchoolsEnabledrelayprovider: false,
          __relay_internal__pv__PolarisRepostsConsumptionEnabledrelayprovider: true,
          __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: true,
          __relay_internal__pv__PolarisProfileInformTreatmentBannerEnabledrelayprovider: false,
          __relay_internal__pv__PolarisProfileRingsGradientEnabledrelayprovider: true
        })
      });

      var res = await fetch(IG_HOME_URL + 'api/graphql', {
        method: 'POST',
        headers: headers,
        credentials: 'include',
        body: body
      });

      if (res.ok) {
        var data = await res.json().catch(function () { return null; });
        var u = data && data.data && data.data.user;
        if (u) {
          return {
            username: u.username || '',
            fullName: u.full_name || '',
            profilePicUrl: (u.hd_profile_pic_url_info && u.hd_profile_pic_url_info.url) || u.profile_pic_url || '',
            followerCount: u.follower_count != null ? u.follower_count : null,
            followingCount: u.following_count != null ? u.following_count : null
          };
        }
      }
    } catch (e) {
      console.warn('[ig-session] GraphQL profile fetch failed:', e);
    }
    return null;
  }

  async function fetchSessionUncached() {
    var steps = [];
    function step(name, outcome) { steps.push(name + ': ' + outcome); }
    function detail() { return steps.join('; '); }

    // Step 0: Check Instagram cookies in browser
    var cookieId = await getCookie('ds_user_id');
    var sessionid = await getCookie('sessionid');
    var cookieCsrf = await getCookie('csrftoken');

    if (!cookieId || !sessionid) {
      step('cookies', 'not logged in (missing ds_user_id or sessionid)');
      return emptySession('logged_out', 'not_logged_in', detail());
    }

    step('cookies', 'ds_user_id=' + cookieId + ', sessionid present');

    var username = '';
    var profilePicUrl = '';
    var followerCount = null;
    var followingCount = null;

    // Check storage cache for instantaneous UI rendering
    var cacheKey = 'ig_profile_' + cookieId;
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      try {
        var stored = await chrome.storage.local.get(cacheKey);
        var cached = stored && stored[cacheKey];
        if (cached && cached.username) {
          username = cached.username;
          profilePicUrl = cached.profilePicUrl || '';
          followerCount = cached.followerCount != null ? cached.followerCount : null;
          followingCount = cached.followingCount != null ? cached.followingCount : null;
          step('cache', '@' + username);
        }
      } catch (e) {}
    }

    // Step 1: Fetch fb_dtsg and Homepage HTML
    var dtsgData = await getFbDtsg();
    var dtsg = dtsgData.dtsg;
    var homeHtml = dtsgData.html;

    // Step 2: Try PolarisProfilePageContentQuery (Official Web GraphQL method)
    if (dtsg) {
      var gqlProfile = await fetchUserProfileFromGraphql(cookieId, cookieCsrf, dtsg);
      if (gqlProfile && gqlProfile.username) {
        username = gqlProfile.username;
        profilePicUrl = gqlProfile.profilePicUrl || profilePicUrl;
        followerCount = gqlProfile.followerCount != null ? gqlProfile.followerCount : followerCount;
        followingCount = gqlProfile.followingCount != null ? gqlProfile.followingCount : followingCount;
        step('graphql', 'ok (@' + username + ')');

        // Persist profile in storage cache
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          try {
            var saveObj = {};
            saveObj[cacheKey] = {
              username: username,
              fullName: gqlProfile.fullName || '',
              profilePicUrl: profilePicUrl,
              followerCount: followerCount,
              followingCount: followingCount,
              updatedAt: Date.now()
            };
            chrome.storage.local.set(saveObj);
          } catch (e) {}
        }

        return {
          status: 'ok',
          reason: '',
          detail: detail(),
          id: cookieId,
          username: username,
          fullName: gqlProfile.fullName || '',
          csrfToken: cookieCsrf,
          profilePicUrl: profilePicUrl,
          followerCount: followerCount,
          followingCount: followingCount
        };
      }
    }

    // Step 3: Fallback - Extract viewer from homepage HTML
    if (homeHtml) {
      var parsed = parseViewerFromHtml(homeHtml);
      if (parsed.username) {
        username = parsed.username;
        profilePicUrl = parsed.profilePicUrl || profilePicUrl;
        if (parsed.csrfToken && !cookieCsrf) cookieCsrf = parsed.csrfToken;
        step('homepage', 'ok (@' + username + ')');
      }
    }

    // Step 4: Fallback - current_user API
    if (!username) {
      try {
        var cuRes = await fetch(CURRENT_USER_URL, {
          credentials: 'include',
          headers: getStandardHeaders(cookieCsrf)
        });
        if (cuRes.ok) {
          var cuData = await cuRes.json().catch(function () { return null; });
          var cuUser = cuData && cuData.user;
          if (cuUser && cuUser.username) {
            username = cuUser.username;
            profilePicUrl = cuUser.profile_pic_url || profilePicUrl;
            step('current_user', 'ok (@' + username + ')');
          }
        }
      } catch (e) {
        step('current_user', 'failed');
      }
    }

    // If username is still not resolved, use a friendly identifier so user is NOT blocked
    if (!username) {
      username = 'user_' + cookieId.slice(-4);
      step('fallback', 'generic username');
    }

    return {
      status: 'ok',
      reason: '',
      detail: detail(),
      id: cookieId,
      username: username,
      fullName: '',
      csrfToken: cookieCsrf,
      profilePicUrl: profilePicUrl,
      followerCount: followerCount,
      followingCount: followingCount
    };
  }

  async function fetchSession(forceRefresh) {
    if (forceRefresh) {
      cachedSession = null;
      try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          await chrome.storage.local.remove('igSessionRateLimit');
        }
      } catch (e) {}
    } else if (cachedSession && cachedSession.status === 'ok') {
      return cachedSession;
    }

    var session = await fetchSessionUncached();
    if (session.status === 'ok') {
      cachedSession = session;
    }
    return session;
  }

  function getJazoest(dtsg) {
    if (!dtsg || typeof dtsg !== 'string') return '';
    var sum = 0;
    for (var i = 0; i < dtsg.length; i++) sum += dtsg.charCodeAt(i);
    return '2' + sum;
  }

  root.IgSession = {
    fetchSession: fetchSession,
    getCookie: getCookie,
    getStandardHeaders: getStandardHeaders,
    getFbDtsg: getFbDtsg,
    getJazoest: getJazoest,
    fetchUserProfileFromGraphql: fetchUserProfileFromGraphql,
    parseViewerFromHtml: parseViewerFromHtml,
    parseProfileIdFromHtml: parseProfileIdFromHtml,
    parseWebFormData: parseWebFormData,
    parseUserIdFromApi: parseUserIdFromApi,
    parseUsernameFromApi: parseUsernameFromApi,
    _resetCache: function () {
      cachedSession = null;
      cachedFbDtsg = null;
      cachedFbDtsgAt = 0;
      try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          chrome.storage.local.remove('igSessionRateLimit');
        }
      } catch (e) {}
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
