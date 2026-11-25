/**
 * Follower/following reader with a reserve path.
 *
 * Background: this extension used to read both lists from Instagram's legacy `graphql/query`
 * endpoints only. Two problems came out of that.
 *
 *   1. The modern web client never touches those endpoints, so every request on them is, by
 *      definition, not coming from the UI. Heavy use gets the account flagged.
 *   2. When Instagram throttles, it answers 200 with an HTML body, or 200 with an empty edge
 *      list. The old reader treated an empty edge list as "the list ended" and returned a
 *      truncated result as if it were complete.
 *
 * So: v1 first, because `api/v1/friendships/{id}/{type}/?search_surface=follow_list_page` is
 * exactly what the site itself calls when you open the follower sheet. The legacy endpoints stay
 * as a one-shot reserve for when v1 refuses.
 *
 * Every page result carries a `kind`. A caller can tell a finished list from a truncated one, which
 * matters here more than in most places: this extension unfollows in bulk off the difference
 * between the two lists, and a short followers list turns real followers into "doesn't follow back".
 *
 * Exposed as window.UnfollowBridge; analyzer.js is a classic script, not a module.
 */
(function () {
  'use strict';

  const IG_APP_ID = '936619743392459';

  /** Hashes the extension has been shipping; kept so the reserve path is a known quantity. */
  const GRAPHQL_QUERY_HASH = {
    followers: '7dd9a7e2160524fd85f50317462cff9f',
    following: '58712303d941c6855d4e888c5f0cd22f'
  };
  const GRAPHQL_EDGE = { followers: 'edge_followed_by', following: 'edge_follow' };

  const SOURCE = { V1: 'v1', GRAPHQL: 'graphql' };

  const SCAN_REASON = {
    COMPLETE: 'complete',
    /** Refused before a single account came back — nothing usable, and nothing to show. */
    BLOCKED: 'blocked',
    /** Some accounts arrived, then Instagram stopped answering. Partial, must not be diffed. */
    RATE_LIMITED: 'rate_limited',
    FAILED: 'failed',
    STOPPED: 'stopped'
  };

  const CONFIG = {
    firstPageSize: 100,
    pageSize: 100,
    minDelayMs: 800,
    maxDelayMs: 1500,
    fallbackPageSize: 100,
    fallbackMinDelayMs: 1000,
    fallbackMaxDelayMs: 2000,
    maxConsecutiveErrors: 3,
    maxRequests: 2000,
    rateLimitBackoffMs: [3000, 6000, 15000]
  };

  const randomBetween = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

  /**
   * Sleep that survives a backgrounded tab.
   *
   * The analyzer runs in its own tab, and users switch away from it. Chrome clamps timers in
   * background tabs to roughly one per second, so a loop that counts iterations overshoots badly.
   * Waiting on a wall-clock deadline instead keeps the real gap honest.
   */
  async function sleepUnlessStopped(ms, shouldStop) {
    const deadline = Date.now() + ms;
    while (true) {
      if (shouldStop && shouldStop()) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, remaining)));
    }
  }

  /**
   * Normalise both shapes into the edge object the rest of analyzer.js already expects.
   * Ids are stringified because v1 hands back a numeric pk while graphql hands back a string —
   * the two lists get compared by id, so a type mismatch would make every account look unmatched.
   */
  function toEdge(user, source) {
    const fromV1 = source === SOURCE.V1;
    return {
      node: {
        id: String(fromV1 ? user.pk ?? user.pk_id ?? user.id : user.id),
        username: user.username,
        full_name: user.full_name || '',
        is_verified: !!user.is_verified,
        is_private: fromV1 ? !!user.is_private : undefined,
        profile_pic_url: user.profile_pic_url || '',
        // Left undefined rather than false when the reserve path supplied the record: graphql does
        // not carry these, and "absent" has to stay distinguishable from "absent and therefore
        // innocent". The bot scorer refuses to score a signal it could not actually test.
        has_anonymous_profile_picture: fromV1 ? !!user.has_anonymous_profile_picture : undefined,
        account_badges: fromV1 ? (Array.isArray(user.account_badges) ? user.account_badges : []) : undefined
      }
    };
  }

  /** True when the body is not the JSON we asked for — Instagram's quiet way of refusing. */
  function looksRefused(response) {
    if (response.status === 429) return true;
    const contentType = response.headers.get('content-type') || '';
    return !contentType.includes('json');
  }

  function buildIgHeaders(token) {
    return {
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'X-Asbd-Id': '198387',
      'X-Ig-App-Id': IG_APP_ID,
      'X-Instagram-AJAX': '1',
      'X-CSRFToken': token || '',
      'X-Requested-With': 'XMLHttpRequest'
    };
  }

  async function readV1Page({ userId, type, cursor, count, token, signal }) {
    if (!token && window.IgSession && typeof window.IgSession.getCookie === 'function') {
      try { token = await window.IgSession.getCookie('csrftoken'); } catch (e) {}
    }
    const query = new URLSearchParams({
      count: String(count || 100),
      search_surface: 'follow_list_page'
    });
    if (cursor) query.set('max_id', cursor);

    let response;
    try {
      response = await fetch(
        `https://www.instagram.com/api/v1/friendships/${userId}/${type}/?${query.toString()}`,
        {
          credentials: 'include',
          signal,
          headers: buildIgHeaders(token)
        }
      );
    } catch (error) {
      return { kind: 'network', error };
    }

    if (response.status === 401 || response.status === 403) return { kind: 'auth' };
    if (response.status === 429) return { kind: 'rate_limited', status: 429 };
    if (response.status >= 500) return { kind: 'error', status: response.status };
    if (looksRefused(response)) return { kind: 'blocked' };

    let payload;
    try {
      payload = await response.json();
    } catch {
      return { kind: 'blocked' };
    }

    if (!payload || !Array.isArray(payload.users)) {
      if (payload && (payload.message === 'feedback_required' || payload.message === 'checkpoint_required')) {
        return { kind: 'blocked', message: payload.message };
      }
      return { kind: 'blocked' };
    }

    return {
      kind: 'ok',
      users: payload.users.map((u) => toEdge(u, SOURCE.V1)),
      cursor: payload.next_max_id ? String(payload.next_max_id) : '',
      hasMore: typeof payload.has_more === 'boolean' ? payload.has_more : !!payload.next_max_id,
      total: typeof payload.total_count === 'number' ? payload.total_count : undefined
    };
  }

  async function querySingleShowManyChunk(userIds) {
    if (!userIds || !userIds.length) return {};
    let csrfToken = '';
    let dtsg = '';
    if (window.IgSession) {
      if (typeof window.IgSession.getCookie === 'function') {
        try { csrfToken = await window.IgSession.getCookie('csrftoken'); } catch (e) {}
      }
      if (typeof window.IgSession.getFbDtsg === 'function') {
        try {
          const d = await window.IgSession.getFbDtsg();
          dtsg = (d && d.dtsg) || '';
        } catch (e) {}
      }
    }
    const headers = buildIgHeaders(csrfToken);
    headers['Content-Type'] = 'application/x-www-form-urlencoded';

    const params = new URLSearchParams({ user_ids: userIds.join(',') });
    if (csrfToken) {
      params.set('_csrftoken', csrfToken);
    }
    if (dtsg) {
      params.set('fb_dtsg', dtsg);
      if (window.IgSession && typeof window.IgSession.getJazoest === 'function') {
        params.set('jazoest', window.IgSession.getJazoest(dtsg));
      }
    }

    try {
      const response = await fetch('https://www.instagram.com/api/v1/friendships/show_many/', {
        method: 'POST',
        headers,
        credentials: 'include',
        body: params.toString()
      });
      if (!response.ok) return null;
      const data = await response.json().catch(() => null);
      if (data && data.status === 'ok' && data.friendship_statuses) {
        return data.friendship_statuses;
      }
    } catch (e) {
      console.warn('[unfollow-bridge] show_many chunk error:', e);
    }
    return null;
  }

  async function showMany(userIds) {
    if (!userIds || !userIds.length) return {};
    // Instagram's show_many API has a batch limit of 30 IDs per call.
    // Querying in chunks of 30 prevents 400 Bad Request and missing follow status.
    const CHUNK_SIZE = 30;
    const allStatuses = {};
    for (let i = 0; i < userIds.length; i += CHUNK_SIZE) {
      const chunk = userIds.slice(i, i + CHUNK_SIZE);
      let res = await querySingleShowManyChunk(chunk);
      if (!res) {
        await sleepUnlessStopped(500);
        res = await querySingleShowManyChunk(chunk);
      }
      if (res) {
        Object.assign(allStatuses, res);
      } else {
        console.warn('[unfollow-bridge] show_many chunk failed for:', chunk);
        return null;
      }
    }
    return allStatuses;
  }

  async function readGraphqlPage({ userId, type, cursor, count, signal }) {
    const variables = { id: String(userId), first: count, after: cursor || '' };
    const url = `https://www.instagram.com/graphql/query/?query_hash=${GRAPHQL_QUERY_HASH[type]}` +
      `&variables=${encodeURIComponent(JSON.stringify(variables))}`;

    let response;
    try {
      response = await fetch(url, {
        credentials: 'include',
        signal,
        headers: buildIgHeaders()
      });
    } catch (error) {
      return { kind: 'network', error };
    }

    if (response.status === 401 || response.status === 403) return { kind: 'auth' };
    if (response.status >= 500) return { kind: 'error' };
    if (looksRefused(response)) return { kind: 'blocked' };

    let payload;
    try {
      payload = await response.json();
    } catch {
      return { kind: 'blocked' };
    }

    const edge = payload?.data?.user?.[GRAPHQL_EDGE[type]];
    // A throttled account gets `user: null` back with a 200. Treating a missing edge as "the list
    // ended" is what produced silently truncated results before.
    if (!edge || !Array.isArray(edge.edges)) return { kind: 'blocked' };

    return {
      kind: 'ok',
      users: edge.edges.map((e) => toEdge(e.node, SOURCE.GRAPHQL)),
      cursor: edge.page_info?.has_next_page ? edge.page_info.end_cursor : '',
      total: typeof edge.count === 'number' ? edge.count : undefined
    };
  }

  /**
   * Read one list end to end.
   *
   * @returns {Promise<{users: Array, reason: string, complete: boolean, source: string,
   *                    usedFallback: boolean, requests: number, total: number|undefined}>}
   *          `complete` is the only field callers should trust before diffing the two lists.
   */
  /**
   * @param {boolean} [options.preferGraphql] Start on graphql and keep v1 in reserve, rather than
   *   the other way round.
   *
   *   v1 leads by default because it is what the site's own follower sheet calls. But on accounts
   *   with a large followers list it is also the one that gets refused: measured on a
   *   17,000-follower account, `api/v1/friendships/{id}/followers/` answered 200-with-HTML from
   *   the first request while graphql served page after page in the same session. Leading with v1
   *   there spends the whole v1 attempt, then restarts from page one on graphql, because a v1
   *   cursor means nothing to it.
   *
   *   The cost of leading with graphql is `account_badges`, which only v1 carries — one signal
   *   that counts in an account's favour, so scores come out slightly harsher without it. The
   *   heaviest signal, the missing profile photo, survives either way: it is recovered from the
   *   avatar URL, which both responses carry.
   */
  async function scanPeers({ userId, type, csrfToken, expected, onProgress, shouldStop, signal, preferGraphql }) {
    const startedAt = Date.now();
    const users = [];
    const seen = new Set();
    let cursor = '';
    let consecutiveErrors = 0;
    let rateLimitHits = 0;
    let requests = 0;
    let total;

    const finish = (reason) => ({
      users,
      reason,
      complete: reason === SCAN_REASON.COMPLETE,
      source: SOURCE.V1,
      usedFallback: false,
      requests,
      total
    });

    while (true) {
      if (shouldStop && shouldStop()) return finish(SCAN_REASON.STOPPED);
      if (requests >= CONFIG.maxRequests) return finish(SCAN_REASON.RATE_LIMITED);

      requests++;
      const page = await readV1Page({ userId, type, cursor, count: CONFIG.pageSize, token: csrfToken, signal });

      if (shouldStop && shouldStop()) return finish(SCAN_REASON.STOPPED);
      if (page.kind === 'auth') return finish(SCAN_REASON.FAILED);

      if (page.kind === 'rate_limited' || page.kind === 'blocked') {
        if (rateLimitHits < 3) {
          rateLimitHits++;
          const waitMs = rateLimitHits * 3500;
          if (onProgress) onProgress({ count: users.length, source: SOURCE.V1, rateLimitedForMs: waitMs });
          await sleepUnlessStopped(waitMs, shouldStop);
          continue;
        }
        return finish(users.length ? SCAN_REASON.RATE_LIMITED : SCAN_REASON.BLOCKED);
      }

      if (page.kind === 'network' || page.kind === 'error') {
        if (++consecutiveErrors < CONFIG.maxConsecutiveErrors) {
          await sleepUnlessStopped(2000 * consecutiveErrors, shouldStop);
          continue;
        }
        return finish(users.length ? SCAN_REASON.RATE_LIMITED : SCAN_REASON.FAILED);
      }

      consecutiveErrors = 0;
      rateLimitHits = 0;
      if (page.total !== undefined) total = page.total;

      for (const edge of page.users) {
        if (seen.has(edge.node.id)) continue;
        seen.add(edge.node.id);
        users.push(edge);
      }

      if (onProgress) {
        const target = expected || total;
        onProgress({
          count: users.length,
          source: SOURCE.V1,
          total: target,
          percent: target ? Math.min(99, Math.round((users.length / target) * 100)) : undefined,
          elapsedMs: Date.now() - startedAt
        });
      }

      if (!page.cursor || page.hasMore === false) return finish(SCAN_REASON.COMPLETE);
      cursor = page.cursor;

      await sleepUnlessStopped(randomBetween(CONFIG.minDelayMs, CONFIG.maxDelayMs), shouldStop);
    }
  }

  /**
   * Viewer identity and csrf token in one call, via the shared session bootstrap (ig-session.js).
   *
   * This used to read /data/shared_data/; Instagram removed that endpoint (404), so the helper
   * now reads the viewer off the Instagram homepage and confirms the sign-in with web_form_data.
   * Runs in two contexts — the analyzer/bot-scan extension pages and the Instagram tab page
   * (ig-content.js injects ig-session.js before this file in both) — so a missing helper
   * degrades to null rather than throwing, and the caller falls back to the extension-page read.
   */
  async function getViewer() {
    if (!window.IgSession || typeof window.IgSession.fetchSession !== 'function') return null;
    let session;
    try {
      session = await window.IgSession.fetchSession();
    } catch {
      return null;
    }
    if (!session || session.status !== 'ok' || !session.id) return null;
    return {
      id: String(session.id),
      username: session.username || '',
      csrfToken: session.csrfToken || ''
    };
  }

  /**
   * The counts Instagram itself displays, used to tell a finished list from a truncated one.
   *
   * Keyed by id rather than username: web_profile_info answers 400 for the viewer's own username,
   * so asking by name would always come back empty for the account doing the scan.
   *
   * Returns null when unavailable — callers then fall back to the scan's own `complete` flag.
   */
  async function getExpectedCounts(userId) {
    if (!userId) return null;
    try {
      if (window.IgSession && typeof window.IgSession.fetchSession === 'function') {
        const session = await window.IgSession.fetchSession();
        if (session && String(session.id) === String(userId) && session.followerCount != null && session.followingCount != null) {
          return {
            followers: session.followerCount,
            following: session.followingCount
          };
        }
      }
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        const stored = await chrome.storage.local.get('ig_profile_' + userId);
        const p = stored && stored['ig_profile_' + userId];
        if (p && p.followerCount != null && p.followingCount != null) {
          return {
            followers: p.followerCount,
            following: p.followingCount
          };
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * The one query that answers "does this person follow me back" without reading the followers list.
   *
   * Every node it returns carries `follows_viewer`, so the whole non-follower question is settled
   * by reading `following` alone. The list we already had to read is the only list we now read;
   * the followers list — the one that is hundreds of pages on a large account, and the one v1 gives
   * up on half way through — is not touched at all.
   *
   * The hash differs from GRAPHQL_QUERY_HASH.following above, and that difference is the point:
   * ours answers without `follows_viewer` or `is_private`, this one answers with both. Measured on
   * two accounts, both fields present on every record across nine pages, and the result matched the
   * old two-list diff exactly — 50 non-followers either way, zero disagreement.
   */
  /**
   * Read `following` with each record's follow-back status attached via show_many.
   * Eliminates dead legacy GraphQL query hashes and reads followers status efficiently.
   */
  async function scanFollowingWithStatus({ userId, expected, onProgress, shouldStop, signal }) {
    const startedAt = Date.now();
    const users = [];
    const seen = new Set();
    let cursor = '';
    let requests = 0;
    let rateLimitHits = 0;
    let total;

    const finish = (reason) => ({
      users,
      reason,
      complete: reason === SCAN_REASON.COMPLETE,
      source: SOURCE.V1,
      usedFallback: false,
      usedStatusReader: true,
      requests,
      total
    });

    while (true) {
      if (shouldStop && shouldStop()) return finish(SCAN_REASON.STOPPED);
      if (requests >= CONFIG.maxRequests) return finish(SCAN_REASON.RATE_LIMITED);

      requests++;
      const page = await readV1Page({ userId, type: 'following', cursor, count: 100, signal });

      if (shouldStop && shouldStop()) return finish(SCAN_REASON.STOPPED);
      if (page.kind === 'auth') return finish(SCAN_REASON.FAILED);

      if (page.kind === 'rate_limited' || page.kind === 'blocked') {
        if (rateLimitHits < 3) {
          rateLimitHits++;
          const waitMs = rateLimitHits * 3500;
          if (onProgress) onProgress({ count: users.length, source: SOURCE.V1, rateLimitedForMs: waitMs });
          await sleepUnlessStopped(waitMs, shouldStop);
          continue;
        }
        if (users.length === 0) return finish('no_status');
        return finish(SCAN_REASON.RATE_LIMITED);
      }

      if (page.kind === 'network' || page.kind === 'error') {
        if (rateLimitHits < 3) {
          rateLimitHits++;
          await sleepUnlessStopped(2000, shouldStop);
          continue;
        }
        return finish(users.length ? SCAN_REASON.RATE_LIMITED : 'no_status');
      }

      rateLimitHits = 0;
      if (page.total !== undefined) total = page.total;

      const pageUserIds = [];
      const newEdges = [];
      for (const edge of page.users) {
        if (seen.has(edge.node.id)) continue;
        seen.add(edge.node.id);
        pageUserIds.push(edge.node.id);
        newEdges.push(edge);
      }

      // Query show_many for follow status
      if (pageUserIds.length > 0) {
        const statuses = await showMany(pageUserIds);
        if (statuses && Object.keys(statuses).length > 0) {
          for (const edge of newEdges) {
            const idStr = String(edge.node.id);
            const st = statuses[idStr] || statuses[edge.node.id];
            if (st) {
              edge.node.follows_viewer = !!(st.followed_by === true || st.followed_by === 1 || st.is_following_me === true || st.following_viewer === true);
              edge.node.is_private = typeof st.is_private === 'boolean' ? st.is_private : edge.node.is_private;
            }
          }
        } else {
          // If show_many fails or is incomplete on ANY page, fall back to two-list read
          // to guarantee zero wrong follow-back verdicts.
          console.warn('[bridge] show_many failed or incomplete, falling back to two-list scan');
          return finish('no_status');
        }
      }

      for (const edge of newEdges) {
        users.push(edge);
      }

      if (onProgress) {
        const target = expected || total;
        onProgress({
          count: users.length,
          source: SOURCE.V1,
          total: target,
          percent: target ? Math.min(99, Math.round((users.length / target) * 100)) : undefined,
          elapsedMs: Date.now() - startedAt
        });
      }

      if (!page.cursor || page.hasMore === false) {
        return finish(SCAN_REASON.COMPLETE);
      }
      cursor = page.cursor;
      await sleepUnlessStopped(randomBetween(CONFIG.minDelayMs, CONFIG.maxDelayMs), shouldStop);
    }
  }

  /**
   * One page of followers, for callers that need a sample rather than the list.
   *
   * The write probe is the only user: it has to unfollow somebody who follows this account but is
   * not followed back, because that request is a no-op whatever Instagram answers. On the
   * follows_viewer path no such account is in memory, and reading the whole followers list to find
   * one would give back the very cost that path exists to avoid.
   *
   * Tries v1 first and graphql second, same order and same refusal handling as the full scan.
   * Returns [] rather than throwing: a probe that cannot find a target reports 'unknown', which is
   * already a state the caller handles.
   */
  async function readFollowersSample({ userId, csrfToken, signal } = {}) {
    if (!userId) return [];
    const v1 = await readV1Page({
      userId, type: 'followers', cursor: '', count: CONFIG.pageSize, token: csrfToken, signal
    });
    if (v1.kind === 'ok' && v1.users.length) return v1.users;
    return [];
  }

  window.UnfollowBridge = {
    SOURCE,
    SCAN_REASON,
    CONFIG,
    scanPeers,
    scanFollowingWithStatus,
    showMany,
    readFollowersSample,
    getViewer,
    getExpectedCounts
  };

  /**
   * Load an Instagram CDN avatar into an <img> without a third-party proxy.
   *
   * Instagram refuses these images to foreign pages, which is why the old build shipped with a
   * worker relay. The extension page itself is privileged instead: with *.cdninstagram.com /
   * *.fbcdn.net in host_permissions, fetch here bypasses CORS and reads the bytes directly,
   * then hands the element an object URL. Same origin story, zero servers in the middle.
   *
   * The caller still sets img.src to the real URL first — that attempt can win when the CDN lets
   * it through — and the element's own onerror fallback still applies if nothing works.
   */
  const avatarCache = new Map();
  const avatarOrder = [];

  function loadAvatar(img, url) {
    if (!img || !url) return;
    const state = avatarCache.get(url);
    if (state === 'pending') return;
    if (state) {
      img.src = state;
      return;
    }
    avatarCache.set(url, 'pending');
    fetch(url, { credentials: 'omit', mode: 'cors' })
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.blob();
      })
      .then((blob) => {
        if (!blob.type.startsWith('image/')) throw new Error('not an image');
        const objectUrl = URL.createObjectURL(blob);
        avatarCache.set(url, objectUrl);
        avatarOrder.push(url);
        // Large lists would otherwise hold hundreds of MB in object URLs; evict the oldest.
        if (avatarOrder.length > 300) {
          const oldest = avatarOrder.shift();
          const evicted = avatarCache.get(oldest);
          if (typeof evicted === 'string') URL.revokeObjectURL(evicted);
          avatarCache.delete(oldest);
        }
        img.src = objectUrl;
      })
      .catch(() => {
        avatarCache.delete(url);
      });
  }

  window.loadAvatar = loadAvatar;
})();
