/**
 * Runs the list reader inside an Instagram page.
 *
 * The analyzer lives on an extension page, so its requests carry `Origin: chrome-extension://…`.
 * The same code executed here leaves from instagram.com itself — same-origin, indistinguishable
 * from the site's own calls, without rewriting a single header.
 *
 * Only reads are routed through this path. Unfollows stay on the analyzer's own connection: if the
 * channel died between "unfollow sent" and "unfollow confirmed", a retry would be a second,
 * unrecoverable action. A re-read costs nothing.
 *
 * Loaded after unfollow-bridge.js, which defines window.UnfollowBridge.
 */
(function () {
  'use strict';

  const REQUEST = 'UA_SCAN_REQUEST';
  const PROGRESS = 'UA_SCAN_PROGRESS';
  const RESULT = 'UA_SCAN_RESULT';
  const READY = 'UA_SCAN_READY';

  /** Scans currently running here, so a second request for the same id does not start twice. */
  const running = new Set();

  // Detach any listener left by an older extension version injected into this same tab
  if (typeof window.__uaDetachInject === 'function') {
    try { window.__uaDetachInject(); } catch (e) {}
  }

  const onMessage = async (event) => {
    if (event.source !== window) return;
    const message = event.data;
    if (!message || message.type !== REQUEST) return;

    const { id, userId, listType, mode, expected, users: poolUsers } = message;
    if (!id || running.has(id)) return;
    running.add(id);

    const bridge = window.UnfollowBridge;
    if (!bridge) {
      window.postMessage({ type: RESULT, id, delivered: false, error: 'bridge missing' }, '*');
      running.delete(id);
      return;
    }

    try {
      const viewer = await bridge.getViewer();
      const onProgress = (progress) => {
        window.postMessage({ type: PROGRESS, id, progress }, '*');
      };

      if (mode === 'verify_pool' && typeof bridge.verifyUsersFollowBack === 'function' && Array.isArray(poolUsers)) {
        const poolRes = await bridge.verifyUsersFollowBack(poolUsers, {
          csrfToken: viewer && viewer.csrfToken,
          concurrency: 3,
          delayMs: 120,
          onProgress: (done, total, mutualsFound) => {
            onProgress({ count: done, total, mutualsFound, elapsedMs: 0 });
          }
        });
        window.postMessage({
          type: RESULT,
          id,
          delivered: true,
          result: {
            users: poolUsers,
            checked: poolRes.checked,
            mutualsFound: poolRes.mutualsFound,
            unresolvedCount: poolRes.unresolvedCount || 0,
            aborted: !!poolRes.aborted,
            stoppedEarly: !!poolRes.stoppedEarly,
            usedVerifyPool: true
          }
        }, '*');
        return;
      }

      const useStatus = mode === 'follows_viewer'
        && typeof bridge.scanFollowingWithStatus === 'function';

      const result = useStatus
        ? await bridge.scanFollowingWithStatus({ userId, expected, csrfToken: viewer && viewer.csrfToken, onProgress })
        : await bridge.scanPeers({
            userId,
            type: listType,
            expected,
            csrfToken: viewer && viewer.csrfToken,
            onProgress,
            preferGraphql: mode === 'graphql_first'
          });

      const usedStatusReader = useStatus;

      window.postMessage({
        type: RESULT,
        id,
        delivered: true,
        result: {
          users: result.users,
          reason: result.reason,
          complete: result.complete,
          source: result.source,
          usedFallback: result.usedFallback,
          requests: result.requests,
          usedStatusReader
        }
      }, '*');
    } catch (error) {
      window.postMessage({
        type: RESULT, id, delivered: false, error: String((error && error.message) || error)
      }, '*');
    } finally {
      running.delete(id);
    }
  };

  window.addEventListener('message', onMessage);
  window.__uaDetachInject = () => window.removeEventListener('message', onMessage);

  // Tells the content script the page side is listening, so a request is never posted into a void.
  window.postMessage({ type: READY }, '*');
})();
