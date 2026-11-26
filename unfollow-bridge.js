/**
 * Follower/following reader with dual-transport fallback and live friendship verification.
 *
 * Architecture:
 *   1. `scanPeers`: Reads `followers` or `following` via Instagram Web's native v1 endpoint
 *      (`api/v1/friendships/{id}/{type}/?search_surface=follow_list_page`) with automatic
 *      one-shot fallback to `graphql/query` (or `preferGraphql: true` for huge follower lists).
 *      Pagination follows `next_max_id` exclusively (never `has_more`, which Instagram Web sets
 *      to `false` even when `big_list: true` and `next_max_id` carry the next page).
 *   2. `scanFollowingWithStatus`: Fast-path GraphQL reader (`FOLLOWS_VIEWER_HASH`) for large
 *      accounts, strictly requiring boolean `follows_viewer` on every single returned node.
 *      (Never derives `follows_viewer` from web `friendships/show_many/`, which omits `followed_by`
 *      and previously caused mutual followers to be misclassified as non-followers.)
 *   3. `checkFriendshipStatus`: Authoritative single-account check (`api/v1/friendships/show/{id}/`)
 *      used both to spot-verify fast-path results and as a live pre-unfollow safety lock so an
 *      account that follows the viewer back is NEVER unfollowed in non-followers mode.
 *
 * Exposed as window.UnfollowBridge; analyzer.js and bot-scan.js are classic scripts.
 */
(function () {
  'use strict';

  const IG_APP_ID = '936619743392459';

  /** Proven GraphQL query hashes for reserve list reads and status fast-path. */
  const GRAPHQL_QUERY_HASH = {
    followers: '7dd9a7e2160524fd85f50317462cff9f',
    following: '58712303d941c6855d4e888c5f0cd22f'
  };
  const GRAPHQL_EDGE = { followers: 'edge_followed_by', following: 'edge_follow' };
  const FOLLOWS_VIEWER_HASH = '3dec7e2c57367ef3da3d987d89f9dbc8';

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
    firstPageSize: 50,
    pageSize: 50,
    minDelayMs: 650,
    maxDelayMs: 1200,
    fallbackPageSize: 50,
    fallbackMinDelayMs: 1000,
    fallbackMaxDelayMs: 1900,
    maxConsecutiveErrors: 3,
    maxRequests: 2500,
    rateLimitBackoffMs: [5000, 15000, 30000]
  };

  function makeRankToken() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  const randomBetween = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

  /**
   * Sleep that survives a backgrounded tab using wall-clock deadlines.
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
   * Normalise both v1 and GraphQL user shapes into the edge object analyzer.js expects.
   * IDs are always stringified numeric IDs and usernames trimmed.
   */
  function toEdge(user, source) {
    const fromV1 = source === SOURCE.V1;
    const rawId = fromV1 ? (user.pk ?? user.pk_id ?? user.id) : (user.id ?? user.pk);
    return {
      node: {
        id: rawId != null ? String(rawId) : '',
        username: user.username ? String(user.username).trim() : '',
        full_name: user.full_name || '',
        is_verified: !!user.is_verified,
        is_private: fromV1 ? !!user.is_private : (typeof user.is_private === 'boolean' ? user.is_private : undefined),
        profile_pic_url: user.profile_pic_url || '',
        // Only set if source genuinely supplied a boolean `follows_viewer`
        follows_viewer: typeof user.follows_viewer === 'boolean' ? user.follows_viewer : undefined,
        has_anonymous_profile_picture: fromV1 ? !!user.has_anonymous_profile_picture : undefined,
        account_badges: fromV1 ? (Array.isArray(user.account_badges) ? user.account_badges : []) : undefined
      }
    };
  }

  /** True when the body is not JSON — Instagram's soft-refusal signature (200 HTML login/challenge). */
  function looksRefused(response) {
    if (response.status === 429) return true;
    const contentType = response.headers.get('content-type') || '';
    return !contentType.includes('json');
  }

  async function resolveCsrfToken(token) {
    if (token) return token;
    if (window.IgSession && typeof window.IgSession.getCookie === 'function') {
      try {
        const c = await window.IgSession.getCookie('csrftoken');
        if (c) return c;
      } catch (e) {}
    }
    return '';
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

  async function readV1Page({ userId, type, cursor, count, token, rankToken, signal }) {
    token = await resolveCsrfToken(token);
    const query = new URLSearchParams({
      count: String(count || CONFIG.pageSize),
      search_surface: 'follow_list_page'
    });
    if (rankToken) query.set('rank_token', rankToken);
    if (cursor) query.set('max_id', cursor);

    let response;
    try {
      response = await fetch(
        `https://www.instagram.com/api/v1/friendships/${encodeURIComponent(userId)}/${type}/?${query.toString()}`,
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

    // CRITICAL: Follow `next_max_id` exclusively! On Instagram Web, `has_more` is frequently `false`
    // even when `big_list: true` and `next_max_id` holds the cursor for the rest of the list.
    const nextCursor = (payload.next_max_id !== undefined && payload.next_max_id !== null && String(payload.next_max_id) !== '')
      ? String(payload.next_max_id)
      : '';

    return {
      kind: 'ok',
      users: payload.users.map((u) => toEdge(u, SOURCE.V1)),
      cursor: nextCursor,
      total: typeof payload.total_count === 'number' ? payload.total_count : undefined
    };
  }

  async function readGraphqlPage({ userId, type, cursor, count, token, signal }) {
    token = await resolveCsrfToken(token);
    const variables = { id: String(userId), first: count || CONFIG.fallbackPageSize, after: cursor || '' };
    const url = `https://www.instagram.com/graphql/query/?query_hash=${GRAPHQL_QUERY_HASH[type]}` +
      `&variables=${encodeURIComponent(JSON.stringify(variables))}`;

    let response;
    try {
      response = await fetch(url, {
        credentials: 'include',
        signal,
        headers: buildIgHeaders(token)
      });
      // If full X-Ig headers were soft-refused on legacy GraphQL, retry once with bare credentials
      // (matching the original v2.0.6 GraphQL request shape).
      if (!cursor && (looksRefused(response) || (!response.ok && response.status !== 401 && response.status !== 403 && response.status !== 429))) {
        response = await fetch(url, { credentials: 'include', signal });
      }
    } catch (error) {
      return { kind: 'network', error };
    }

    if (response.status === 401 || response.status === 403) return { kind: 'auth' };
    if (response.status === 429) return { kind: 'rate_limited', status: 429 };
    if (response.status >= 500) return { kind: 'error' };
    if (looksRefused(response)) return { kind: 'blocked' };

    let payload;
    try {
      payload = await response.json();
    } catch {
      return { kind: 'blocked' };
    }

    const edge = payload?.data?.user?.[GRAPHQL_EDGE[type]];
    if (!edge || !Array.isArray(edge.edges)) return { kind: 'blocked' };

    return {
      kind: 'ok',
      users: edge.edges.map((e) => toEdge(e.node, SOURCE.GRAPHQL)),
      cursor: edge.page_info?.has_next_page ? (edge.page_info.end_cursor || '') : '',
      total: typeof edge.count === 'number' ? edge.count : undefined
    };
  }

  /**
   * Read one list (`followers` or `following`) end to end with automatic V1 <-> GraphQL fallback.
   */
  async function scanPeers({ userId, type, csrfToken, expected, onProgress, shouldStop, signal, preferGraphql }) {
    const startedAt = Date.now();
    const users = [];
    const seen = new Set();
    let seenCursors = new Set();
    let cursor = '';
    let transport = (preferGraphql && GRAPHQL_QUERY_HASH[type]) ? SOURCE.GRAPHQL : SOURCE.V1;
    let triedFallback = false;
    let consecutiveErrors = 0;
    let rateLimitHits = 0;
    let requests = 0;
    let total;
    const rankToken = makeRankToken();

    const finish = (reason) => ({
      users,
      reason,
      complete: reason === SCAN_REASON.COMPLETE,
      source: transport,
      usedFallback: triedFallback,
      requests,
      total
    });

    const switchToFallback = () => {
      if (triedFallback) return false;
      const other = transport === SOURCE.V1 ? SOURCE.GRAPHQL : SOURCE.V1;
      if (other === SOURCE.GRAPHQL && !GRAPHQL_QUERY_HASH[type]) return false;
      triedFallback = true;
      transport = other;
      cursor = '';
      seenCursors = new Set();
      consecutiveErrors = 0;
      rateLimitHits = 0;
      return true;
    };

    while (true) {
      if (shouldStop && shouldStop()) return finish(SCAN_REASON.STOPPED);
      if (requests >= CONFIG.maxRequests) return finish(SCAN_REASON.RATE_LIMITED);

      const onGraphql = transport === SOURCE.GRAPHQL;
      const count = onGraphql
        ? CONFIG.fallbackPageSize
        : (cursor ? CONFIG.pageSize : CONFIG.firstPageSize);

      requests++;
      const page = onGraphql
        ? await readGraphqlPage({ userId, type, cursor, count, token: csrfToken, signal })
        : await readV1Page({ userId, type, cursor, count, token: csrfToken, rankToken, signal });

      if (shouldStop && shouldStop()) return finish(SCAN_REASON.STOPPED);
      if (page.kind === 'auth') return finish(SCAN_REASON.FAILED);

      if (page.kind === 'network' || page.kind === 'error') {
        if (++consecutiveErrors >= CONFIG.maxConsecutiveErrors) {
          if (switchToFallback()) continue;
          return finish(users.length ? SCAN_REASON.RATE_LIMITED : SCAN_REASON.FAILED);
        }
        const base = onGraphql
          ? randomBetween(CONFIG.fallbackMinDelayMs, CONFIG.fallbackMaxDelayMs)
          : randomBetween(CONFIG.minDelayMs, CONFIG.maxDelayMs);
        await sleepUnlessStopped(base * consecutiveErrors, shouldStop);
        continue;
      }

      if (page.kind === 'rate_limited' || page.kind === 'blocked') {
        if (switchToFallback()) continue;
        if (users.length === 0) return finish(SCAN_REASON.BLOCKED);

        const backoff = CONFIG.rateLimitBackoffMs[rateLimitHits];
        if (backoff === undefined) return finish(SCAN_REASON.RATE_LIMITED);
        rateLimitHits++;
        if (onProgress) onProgress({ count: users.length, source: transport, rateLimitedForMs: backoff });
        await sleepUnlessStopped(backoff, shouldStop);
        continue;
      }

      consecutiveErrors = 0;
      rateLimitHits = 0;
      if (page.total !== undefined) total = page.total;

      for (const edge of page.users) {
        const key = edge.node.id || (edge.node.username ? '@' + edge.node.username.toLowerCase() : '');
        if (!key || seen.has(key)) continue;
        seen.add(key);
        users.push(edge);
      }

      const targetTotal = expected || total;
      if (onProgress) {
        onProgress({
          count: users.length,
          source: transport,
          total: targetTotal,
          percent: targetTotal ? Math.min(99, Math.round((users.length / targetTotal) * 100)) : undefined,
          elapsedMs: Date.now() - startedAt
        });
      }

      const cursorEnded = !page.cursor || page.users.length === 0 || seenCursors.has(page.cursor);
      if (cursorEnded) {
        // If one transport silently truncated early (e.g. V1 soft-cap dropping next_max_id),
        // switch to the reserve transport and merge any missing accounts!
        const minAcceptable = targetTotal && targetTotal >= 15
          ? Math.min(targetTotal - 3, Math.floor(targetTotal * 0.96))
          : 0;
        if (minAcceptable > 0 && users.length < minAcceptable) {
          if (switchToFallback()) continue;
        }
        return finish(SCAN_REASON.COMPLETE);
      }

      seenCursors.add(page.cursor);
      cursor = page.cursor;

      const minDelay = onGraphql ? CONFIG.fallbackMinDelayMs : CONFIG.minDelayMs;
      const maxDelay = onGraphql ? CONFIG.fallbackMaxDelayMs : CONFIG.maxDelayMs;
      await sleepUnlessStopped(randomBetween(minDelay, maxDelay), shouldStop);
    }
  }

  /**
   * Viewer identity and csrf token via ig-session.js.
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
   * Live follower/following counts across Web-native sources (IgSession Polaris GraphQL,
   * 1-node GraphQL edge count, `api/v1/users/{id}/info/`, and storage fallback).
   */
  async function getExpectedCounts(userId) {
    if (!userId) return null;
    let followers = null;
    let following = null;

    // 1. IgSession (PolarisProfilePageContentQuery — official Web profile query)
    try {
      if (window.IgSession && typeof window.IgSession.fetchSession === 'function') {
        const session = await window.IgSession.fetchSession();
        if (session && String(session.id) === String(userId)) {
          if (typeof session.followerCount === 'number') followers = session.followerCount;
          if (typeof session.followingCount === 'number') following = session.followingCount;
          if (followers != null && following != null) return { followers, following };
        }
      }
    } catch {}

    // 2. Web GraphQL 1-item edge count (works cleanly on desktop Chrome even when mobile v1 info 400s)
    try {
      const token = await resolveCsrfToken('');
      if (followers == null) {
        const fPage = await readGraphqlPage({ userId, type: 'followers', cursor: '', count: 1, token });
        if (fPage.kind === 'ok' && typeof fPage.total === 'number') followers = fPage.total;
      }
      if (following == null) {
        const gPage = await readGraphqlPage({ userId, type: 'following', cursor: '', count: 1, token });
        if (gPage.kind === 'ok' && typeof gPage.total === 'number') following = gPage.total;
      }
      if (followers != null && following != null) return { followers, following };
    } catch {}

    // 3. v1 users/{id}/info/ fallback
    try {
      const token = await resolveCsrfToken('');
      const response = await fetch(
        `https://www.instagram.com/api/v1/users/${encodeURIComponent(userId)}/info/`,
        { credentials: 'include', headers: buildIgHeaders(token) }
      );
      if (response.ok && !looksRefused(response)) {
        const data = await response.json().catch(() => null);
        const user = data?.user;
        if (user) {
          if (followers == null && typeof user.follower_count === 'number') followers = user.follower_count;
          if (following == null && typeof user.following_count === 'number') following = user.following_count;
          if (followers != null && following != null) return { followers, following };
        }
      }
    } catch {}

    // 4. Local profile cache fallback
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        const stored = await chrome.storage.local.get('ig_profile_' + userId);
        const p = stored && stored['ig_profile_' + userId];
        if (p) {
          if (followers == null && p.followerCount != null) followers = p.followerCount;
          if (following == null && p.followingCount != null) following = p.followingCount;
        }
      }
    } catch {}

    if (followers != null || following != null) {
      return { followers: followers ?? undefined, following: following ?? undefined };
    }
    return null;
  }

  function toStatusEdge(user) {
    return {
      node: {
        id: String(user.id ?? user.pk ?? ''),
        username: user.username ? String(user.username).trim() : '',
        full_name: user.full_name || '',
        is_verified: !!user.is_verified,
        is_private: !!user.is_private,
        profile_pic_url: user.profile_pic_url || '',
        follows_viewer: user.follows_viewer === true,
        has_anonymous_profile_picture: undefined,
        account_badges: undefined
      }
    };
  }

  async function readFollowingStatusPage({ userId, cursor, count, token, signal }) {
    token = await resolveCsrfToken(token);
    const variables = {
      id: String(userId),
      include_reel: true,
      fetch_mutual: false,
      first: count || CONFIG.fallbackPageSize,
      ...(cursor ? { after: cursor } : {})
    };
    const url = `https://www.instagram.com/graphql/query/?query_hash=${FOLLOWS_VIEWER_HASH}` +
      `&variables=${encodeURIComponent(JSON.stringify(variables))}`;

    let response;
    try {
      response = await fetch(url, {
        credentials: 'include',
        signal,
        headers: buildIgHeaders(token)
      });
      // If full X-Ig headers were soft-refused on legacy GraphQL, retry once with bare credentials
      // (matching the original v2.0.6 GraphQL request shape).
      if (!cursor && (looksRefused(response) || (!response.ok && response.status !== 401 && response.status !== 403 && response.status !== 429))) {
        response = await fetch(url, { credentials: 'include', signal });
      }
    } catch (error) {
      return { kind: 'network', error };
    }
    if (response.status === 401 || response.status === 403) return { kind: 'auth' };
    if (response.status === 429) return { kind: 'blocked' };
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

    // STRICT SAFETY INVARIANT: Every single returned node MUST carry an explicit boolean
    // `follows_viewer`. If even one node omits it, reject the response as `no_status` so the
    // caller falls back to the two-list diff instead of marking real followers as non-followers.
    for (const item of edge.edges) {
      const node = item && item.node;
      if (!node || !('follows_viewer' in node) || typeof node.follows_viewer !== 'boolean') {
        return { kind: 'no_status' };
      }
    }

    return {
      kind: 'ok',
      users: edge.edges.map((e) => toStatusEdge(e.node)),
      total: typeof edge.count === 'number' ? edge.count : undefined,
      cursor: edge.page_info?.has_next_page ? (edge.page_info.end_cursor || '') : ''
    };
  }

  /**
   * Read `following` with each record's `follows_viewer` boolean attached via GraphQL.
   * Returns `reason: 'no_status'` (`complete: false`) if the endpoint refuses or omits the field,
   * allowing the caller to fall back cleanly to the two-list scan.
   */
  async function scanFollowingWithStatus({ userId, expected, onProgress, shouldStop, signal }) {
    const startedAt = Date.now();
    const users = [];
    const seen = new Set();
    const seenCursors = new Set();
    let cursor = '';
    let consecutiveErrors = 0;
    let rateLimitHits = 0;
    let requests = 0;
    let total;

    const finish = (reason) => ({
      users,
      reason,
      complete: reason === SCAN_REASON.COMPLETE,
      source: SOURCE.GRAPHQL,
      usedFallback: false,
      usedStatusReader: true,
      requests,
      total
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
          return finish(users.length ? SCAN_REASON.RATE_LIMITED : 'no_status');
        }
        await sleepUnlessStopped(
          randomBetween(CONFIG.fallbackMinDelayMs, CONFIG.fallbackMaxDelayMs) * consecutiveErrors,
          shouldStop
        );
        continue;
      }

      if (page.kind === 'blocked') {
        if (users.length === 0) return finish('no_status');
        const backoff = CONFIG.rateLimitBackoffMs[rateLimitHits];
        if (backoff === undefined) return finish(SCAN_REASON.RATE_LIMITED);
        rateLimitHits++;
        if (onProgress) onProgress({ count: users.length, source: SOURCE.GRAPHQL, rateLimitedForMs: backoff });
        await sleepUnlessStopped(backoff, shouldStop);
        continue;
      }

      consecutiveErrors = 0;
      rateLimitHits = 0;
      if (page.total !== undefined) total = page.total;

      for (const edge of page.users) {
        const key = edge.node.id || (edge.node.username ? '@' + edge.node.username.toLowerCase() : '');
        if (!key || seen.has(key)) continue;
        seen.add(key);
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

      if (!page.cursor || page.users.length === 0) return finish(SCAN_REASON.COMPLETE);
      if (seenCursors.has(page.cursor)) return finish(SCAN_REASON.COMPLETE);
      seenCursors.add(page.cursor);
      cursor = page.cursor;

      await sleepUnlessStopped(
        randomBetween(CONFIG.fallbackMinDelayMs, CONFIG.fallbackMaxDelayMs), shouldStop
      );
    }
  }

  /**
   * Authoritative single-user relationship check via `GET /api/v1/friendships/show/{targetUserId}/`.
   * Unlike `show_many` on web (which omits `followed_by`), `friendships/show/{id}/` returns the
   * complete relationship object including boolean `followed_by`.
   *
   * Used both to spot-verify fast-path scans and as a pre-unfollow safety check so mutual followers
   * are NEVER unfollowed by mistake.
   */
  async function checkFriendshipStatus(targetUserId, csrfToken) {
    if (!targetUserId) return { ok: false };
    try {
      const token = await resolveCsrfToken(csrfToken);
      const response = await fetch(
        `https://www.instagram.com/api/v1/friendships/show/${encodeURIComponent(targetUserId)}/`,
        {
          method: 'GET',
          credentials: 'include',
          headers: buildIgHeaders(token)
        }
      );
      if (!response.ok || looksRefused(response)) return { ok: false, status: response.status };
      const data = await response.json().catch(() => null);
      if (!data || typeof data.followed_by !== 'boolean') {
        return { ok: false };
      }
      return {
        ok: true,
        followedBy: data.followed_by === true,
        following: data.following === true,
        incomingRequest: data.incoming_request === true,
        outgoingRequest: data.outgoing_request === true,
        isPrivate: typeof data.is_private === 'boolean' ? data.is_private : undefined
      };
    } catch {
      return { ok: false };
    }
  }

  /**
   * One page of followers, trying v1 first and graphql second.
   */
  async function readFollowersSample({ userId, csrfToken, signal } = {}) {
    if (!userId) return [];
    const v1 = await readV1Page({
      userId, type: 'followers', cursor: '', count: CONFIG.pageSize, token: csrfToken, signal
    });
    if (v1.kind === 'ok' && v1.users.length) return v1.users;

    const gql = await readGraphqlPage({
      userId, type: 'followers', cursor: '', count: CONFIG.fallbackPageSize, token: csrfToken, signal
    });
    return gql.kind === 'ok' ? gql.users : [];
  }

  /**
   * Gently verifies a batch of suspected non-followers against Instagram's authoritative
   * `GET /api/v1/friendships/show/{id}/` endpoint (the same endpoint Instagram Web profile
   * hover-cards use to render the "Follows you" pill).
   *
   * Stops immediately on rate-limiting so it never pressures the session.
   */
  async function verifyUsersFollowBack(users, {
    csrfToken,
    delayMs = 260,
    onProgress,
    onMutualFound,
    shouldStop
  } = {}) {
    if (!Array.isArray(users) || !users.length) return { checked: 0, mutualsFound: 0, stoppedEarly: false };
    const token = await resolveCsrfToken(csrfToken);
    let checked = 0;
    let mutualsFound = 0;
    let consecutiveFailures = 0;

    for (const u of users) {
      if (shouldStop && shouldStop()) return { checked, mutualsFound, stoppedEarly: true };
      const uid = u?.node?.id != null ? String(u.node.id) : '';
      if (!uid) continue;

      const rel = await checkFriendshipStatus(uid, token);
      if (!rel || !rel.ok) {
        if (rel?.status === 429 || ++consecutiveFailures >= 2) {
          return { checked, mutualsFound, stoppedEarly: true };
        }
        continue;
      }

      consecutiveFailures = 0;
      checked++;
      u.node.follows_viewer = rel.followedBy === true;
      u.node._friendshipVerified = true;

      if (rel.followedBy === true) {
        mutualsFound++;
        if (onMutualFound) onMutualFound(u, rel);
      }
      if (onProgress) onProgress(checked, users.length, mutualsFound);

      if (checked < users.length && delayMs > 0) {
        await sleepUnlessStopped(delayMs, shouldStop);
      }
    }

    return { checked, mutualsFound, stoppedEarly: false };
  }

  window.UnfollowBridge = {
    SOURCE,
    SCAN_REASON,
    CONFIG,
    scanPeers,
    scanFollowingWithStatus,
    checkFriendshipStatus,
    verifyUsersFollowBack,
    readFollowersSample,
    getViewer,
    getExpectedCounts
  };

  /**
   * Load an Instagram CDN avatar into an <img> via extension host_permissions.
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
