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
    /** The site asks for 12 on the first page of the sheet; matching that keeps the opening quiet. */
    firstPageSize: 12,
    /**
     * Measured, not chosen: v1 hands back about 23 accounts per request no matter what `count`
     * says — 50, 100 and 200 all return the same page. The value is kept at 50 because that is
     * what the site itself sends, and asking for more buys nothing.
     */
    pageSize: 50,
    /**
     * Randomised, so the cadence doesn't read as a machine ticking on a fixed interval.
     *
     * Roughly one request every 425ms, tightened from 550ms at the owner's request after watching
     * a 17,000-follower list take nearly seven minutes. That is about 2.4 requests a second.
     *
     * For reference, the behaviour that was getting accounts flagged ran two parallel streams at a
     * fixed 300ms — about six a second. This stays sequential and under half of that, but the
     * trade is real and unmeasured: request rate is what draws the throttling, and there is no
     * threshold published anywhere to aim at. If accounts start getting held off more often, this
     * pair is the first thing to put back.
     */
    minDelayMs: 250,
    maxDelayMs: 600,
    fallbackPageSize: 50,
    /**
     * Still slower per request than v1, and deliberately so: this path is only reached because the
     * account is already being held back, and it is the one that draws attention.
     *
     * Tightened from 1500–3000 to 1200–2400 — about 1800ms average — for the same reason as above.
     * It reads roughly twice as many accounts per request as v1, so the pages are worth more; what
     * makes it feel slow is that a fallback re-reads the list from the beginning, since the v1
     * cursor means nothing here.
     */
    fallbackMinDelayMs: 1200,
    fallbackMaxDelayMs: 2400,
    maxConsecutiveErrors: 3,
    /**
     * Ceiling on requests for one list. At 50 accounts a page this covers 100,000 followers, so it
     * never fires for a real account — it exists only so a repeating cursor cannot loop forever.
     */
    maxRequests: 2000,
    /** Each 429 waits longer; when the patience runs out we stop rather than keep pushing. */
    rateLimitBackoffMs: [30000, 60000, 120000]
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

  async function readV1Page({ userId, type, cursor, count, token, signal }) {
    const query = new URLSearchParams({
      count: String(count),
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
          headers: {
            'x-ig-app-id': IG_APP_ID,
            'x-csrftoken': token || '',
            'x-requested-with': 'XMLHttpRequest'
          }
        }
      );
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

    if (!payload || !Array.isArray(payload.users)) return { kind: 'blocked' };

    return {
      kind: 'ok',
      users: payload.users.map((u) => toEdge(u, SOURCE.V1)),
      cursor: payload.next_max_id || ''
    };
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
        headers: { 'x-requested-with': 'XMLHttpRequest' }
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
    let transport = (preferGraphql && GRAPHQL_QUERY_HASH[type]) ? SOURCE.GRAPHQL : SOURCE.V1;
    let triedFallback = false;
    let consecutiveErrors = 0;
    let rateLimitHits = 0;
    let requests = 0;
    let total;

    const finish = (reason) => ({
      users,
      reason,
      complete: reason === SCAN_REASON.COMPLETE,
      source: transport,
      usedFallback: triedFallback,
      requests,
      total
    });

    /**
     * Move to whichever endpoint is not being used, once. Returns false when there is nowhere
     * left to go — which is either transport already having been swapped, or graphql being the
     * one to swap to for a list it has no query hash for.
     */
    const switchToFallback = () => {
      if (triedFallback) return false;
      const other = transport === SOURCE.V1 ? SOURCE.GRAPHQL : SOURCE.V1;
      if (other === SOURCE.GRAPHQL && !GRAPHQL_QUERY_HASH[type]) return false;
      triedFallback = true;
      transport = other;
      cursor = '';
      consecutiveErrors = 0;
      rateLimitHits = 0;
      // Either path re-reads from the start: the two cursors are not interchangeable in either
      // direction, so previously seen ids must not be double counted.
      return true;
    };

    while (true) {
      if (shouldStop && shouldStop()) return finish(SCAN_REASON.STOPPED);

      // A runaway guard, not a product limit: if Instagram ever hands back the same cursor
      // forever, the loop would otherwise never end. Set far above any real account.
      if (requests >= CONFIG.maxRequests) return finish(SCAN_REASON.RATE_LIMITED);

      const onFallback = transport === SOURCE.GRAPHQL;
      // Keyed on the cursor rather than on the request count: a first page that had to be retried
      // is still a first page, and should still ask for the small opening batch the site uses.
      const count = onFallback
        ? CONFIG.fallbackPageSize
        : (cursor ? CONFIG.pageSize : CONFIG.firstPageSize);

      requests++;
      const page = onFallback
        ? await readGraphqlPage({ userId, type, cursor, count, signal })
        : await readV1Page({ userId, type, cursor, count, token: csrfToken, signal });

      if (shouldStop && shouldStop()) return finish(SCAN_REASON.STOPPED);

      if (page.kind === 'auth') return finish(SCAN_REASON.FAILED);

      if (page.kind === 'network' || page.kind === 'error') {
        if (++consecutiveErrors >= CONFIG.maxConsecutiveErrors) {
          if (switchToFallback()) continue;
          return finish(users.length ? SCAN_REASON.RATE_LIMITED : SCAN_REASON.FAILED);
        }
        // Each retry waits longer than the last, so a struggling connection or a wobbling server
        // is not met with a fixed drumbeat of requests.
        const base = transport === SOURCE.GRAPHQL
          ? randomBetween(CONFIG.fallbackMinDelayMs, CONFIG.fallbackMaxDelayMs)
          : randomBetween(CONFIG.minDelayMs, CONFIG.maxDelayMs);
        await sleepUnlessStopped(base * consecutiveErrors, shouldStop);
        continue;
      }

      if (page.kind === 'blocked') {
        // Refused: try the other endpoint first, since that is the whole point of having one.
        if (switchToFallback()) continue;

        // Refused with nothing collected and no endpoint left. The limit is on the account, not
        // on our pace, so waiting would spend minutes to learn the same thing. Stop now and let
        // the caller say so — a user watching a spinner for three and a half minutes before being
        // told it failed is worse than being told immediately.
        if (users.length === 0) return finish(SCAN_REASON.BLOCKED);

        // Mid-list: the rows already collected are real, so back off and try to finish rather
        // than throwing them away.
        const backoff = CONFIG.rateLimitBackoffMs[rateLimitHits];
        if (backoff === undefined) return finish(SCAN_REASON.RATE_LIMITED);
        rateLimitHits++;
        if (onProgress) onProgress({ count: users.length, source: transport, rateLimitedForMs: backoff });
        await sleepUnlessStopped(backoff, shouldStop);
        continue;
      }

      consecutiveErrors = 0;
      if (page.total !== undefined) total = page.total;

      for (const edge of page.users) {
        if (seen.has(edge.node.id)) continue;
        seen.add(edge.node.id);
        users.push(edge);
      }

      if (onProgress) {
        // The caller draws a bar from this, so it gets everything needed to do so without
        // having to time the scan itself: how many are expected, and how long it has taken.
        const target = expected || total;
        onProgress({
          count: users.length,
          source: transport,
          total: target,
          percent: target ? Math.min(99, Math.round((users.length / target) * 100)) : undefined,
          elapsedMs: Date.now() - startedAt
        });
      }

      if (!page.cursor) return finish(SCAN_REASON.COMPLETE);
      cursor = page.cursor;

      const minDelay = onFallback ? CONFIG.fallbackMinDelayMs : CONFIG.minDelayMs;
      const maxDelay = onFallback ? CONFIG.fallbackMaxDelayMs : CONFIG.maxDelayMs;
      await sleepUnlessStopped(randomBetween(minDelay, maxDelay), shouldStop);
    }
  }

  /** Viewer identity and csrf token in one call; the page already relies on this endpoint. */
  async function getViewer() {
    const response = await fetch('https://www.instagram.com/data/shared_data/', {
      credentials: 'include'
    });
    if (looksRefused(response)) return null;
    let data;
    try {
      data = await response.json();
    } catch {
      return null;
    }
    const viewer = data?.config?.viewer;
    if (!viewer?.id) return null;
    return {
      id: String(viewer.id),
      username: viewer.username || '',
      csrfToken: data?.config?.csrf_token || ''
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
      const response = await fetch(
        `https://www.instagram.com/api/v1/users/${encodeURIComponent(userId)}/info/`,
        { credentials: 'include', headers: { 'x-ig-app-id': IG_APP_ID } }
      );
      if (looksRefused(response)) return null;
      const data = await response.json();
      const user = data?.user;
      if (!user) return null;
      return {
        followers: user.follower_count,
        following: user.following_count
      };
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
  const FOLLOWS_VIEWER_HASH = '3dec7e2c57367ef3da3d987d89f9dbc8';

  function toStatusEdge(user) {
    return {
      node: {
        id: String(user.id),
        username: user.username,
        full_name: user.full_name || '',
        is_verified: !!user.is_verified,
        is_private: !!user.is_private,
        profile_pic_url: user.profile_pic_url || '',
        // The answer this whole path exists for.
        follows_viewer: !!user.follows_viewer,
        // Not carried by this query. Left undefined rather than false so the bot scorer keeps
        // refusing to score a signal it could not test — same rule as the reserve reader above.
        has_anonymous_profile_picture: undefined,
        account_badges: undefined
      }
    };
  }

  async function readFollowingStatusPage({ userId, cursor, count, signal }) {
    const variables = {
      id: String(userId), include_reel: true, fetch_mutual: false, first: count,
      ...(cursor ? { after: cursor } : {})
    };
    const url = `https://www.instagram.com/graphql/query/?query_hash=${FOLLOWS_VIEWER_HASH}` +
      `&variables=${encodeURIComponent(JSON.stringify(variables))}`;

    let response;
    try {
      response = await fetch(url, { credentials: 'include', signal });
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
    const edge = payload?.data?.user?.edge_follow;
    if (!edge || !Array.isArray(edge.edges)) return { kind: 'blocked' };

    // A page that answers but has lost the field would silently mark everyone as a non-follower,
    // and the bulk unfollow button acts on exactly that list. Treat it as unusable, not as data.
    const first = edge.edges[0]?.node;
    if (first && !('follows_viewer' in first)) return { kind: 'no_status' };

    return {
      kind: 'ok',
      users: edge.edges.map((e) => toStatusEdge(e.node)),
      total: edge.count,
      cursor: edge.page_info?.has_next_page ? edge.page_info.end_cursor : ''
    };
  }

  /**
   * Read `following` with each record's follow-back status attached.
   *
   * Deliberately has no fallback of its own: if this query stops working the caller drops back to
   * the two-list read, which is still there and unchanged. Reason `NO_STATUS` is what says so.
   */
  async function scanFollowingWithStatus({ userId, expected, onProgress, shouldStop, signal }) {
    const startedAt = Date.now();
    const users = [];
    const seen = new Set();
    let cursor = '';
    let consecutiveErrors = 0;
    let rateLimitHits = 0;
    let requests = 0;
    let total;

    const finish = (reason) => ({
      users, reason,
      complete: reason === SCAN_REASON.COMPLETE,
      source: SOURCE.GRAPHQL,
      usedFallback: false,
      requests, total
    });

    while (true) {
      if (shouldStop && shouldStop()) return finish(SCAN_REASON.STOPPED);
      if (requests >= CONFIG.maxRequests) return finish(SCAN_REASON.RATE_LIMITED);

      requests++;
      const page = await readFollowingStatusPage({
        userId, cursor, count: CONFIG.fallbackPageSize, signal
      });

      if (shouldStop && shouldStop()) return finish(SCAN_REASON.STOPPED);
      if (page.kind === 'auth') return finish(SCAN_REASON.FAILED);
      if (page.kind === 'no_status') return finish('no_status');

      if (page.kind === 'network' || page.kind === 'error') {
        if (++consecutiveErrors >= CONFIG.maxConsecutiveErrors) {
          return finish(users.length ? SCAN_REASON.RATE_LIMITED : SCAN_REASON.FAILED);
        }
        await sleepUnlessStopped(
          randomBetween(CONFIG.fallbackMinDelayMs, CONFIG.fallbackMaxDelayMs) * consecutiveErrors,
          shouldStop
        );
        continue;
      }

      if (page.kind === 'blocked') {
        if (users.length === 0) return finish(SCAN_REASON.BLOCKED);
        const backoff = CONFIG.rateLimitBackoffMs[rateLimitHits];
        if (backoff === undefined) return finish(SCAN_REASON.RATE_LIMITED);
        rateLimitHits++;
        if (onProgress) onProgress({ count: users.length, source: SOURCE.GRAPHQL, rateLimitedForMs: backoff });
        await sleepUnlessStopped(backoff, shouldStop);
        continue;
      }

      consecutiveErrors = 0;
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
          source: SOURCE.GRAPHQL,
          total: target,
          percent: target ? Math.min(99, Math.round((users.length / target) * 100)) : undefined,
          elapsedMs: Date.now() - startedAt
        });
      }

      if (!page.cursor) return finish(SCAN_REASON.COMPLETE);
      cursor = page.cursor;
      await sleepUnlessStopped(
        randomBetween(CONFIG.fallbackMinDelayMs, CONFIG.fallbackMaxDelayMs), shouldStop
      );
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

    const gql = await readGraphqlPage({
      userId, type: 'followers', cursor: '', count: CONFIG.fallbackPageSize, signal
    });
    return gql.kind === 'ok' ? gql.users : [];
  }

  window.UnfollowBridge = {
    SOURCE,
    SCAN_REASON,
    CONFIG,
    scanPeers,
    scanFollowingWithStatus,
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
