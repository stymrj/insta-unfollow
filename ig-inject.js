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

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const message = event.data;
    if (!message || message.type !== REQUEST) return;

    const { id, userId, listType, mode } = message;
    if (!id || running.has(id)) return;
    running.add(id);

    const bridge = window.UnfollowBridge;
    if (!bridge) {
      // The reader failed to load; say so rather than leaving the caller waiting, so it can fall
      // back to scanning from the extension page.
      window.postMessage({ type: RESULT, id, delivered: false, error: 'bridge missing' }, '*');
      running.delete(id);
      return;
    }

    try {
      const viewer = await bridge.getViewer();
      const onProgress = (progress) => {
        window.postMessage({ type: PROGRESS, id, progress }, '*');
      };

      // The follow-back read is the one that matters most for this to happen here: it is the read
      // every analysis performs, so it is the one whose requests are worth having leave from
      // instagram.com. An unknown mode, or a page script older than the caller, falls through to
      // the two-list read rather than failing.
      const useStatus = mode === 'follows_viewer'
        && typeof bridge.scanFollowingWithStatus === 'function';

      const result = useStatus
        ? await bridge.scanFollowingWithStatus({ userId, onProgress })
        : await bridge.scanPeers({
            userId,
            type: listType,
            csrfToken: viewer && viewer.csrfToken,
            onProgress,
            // An older page script ignores this and reads v1-first, which is the behaviour that
            // shipped before — slower on a large list, never wrong.
            preferGraphql: mode === 'graphql_first'
          });

      // Says which reader actually ran, so the caller is never left assuming it got status data
      // from a page that quietly did the old read instead.
      const usedStatusReader = useStatus;

      // Structured-clone safe: only plain data crosses postMessage.
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
  });

  // Tells the content script the page side is listening, so a request is never posted into a void.
  window.postMessage({ type: READY }, '*');
})();
