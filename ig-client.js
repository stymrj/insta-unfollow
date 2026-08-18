/**
 * Analyzer-side half of the page bridge.
 *
 * Asks an open Instagram tab to run a read on our behalf, so the requests leave from
 * instagram.com rather than from this extension page. Everything here is best-effort: if no tab is
 * open, or the tab goes away, `delivered` comes back false and the caller reads the list itself.
 * That fallback is the behaviour this extension has always had, so the worst case is the status quo.
 *
 * Exposed as window.UnfollowPageBridge; analyzer.js is a classic script, not a module.
 */
(function () {
  'use strict';

  /**
   * How long to wait with no word at all before deciding the page is not coming back.
   * Reset by every progress message, so a genuinely long read is never cut off — only a silent one.
   */
  const IDLE_TIMEOUT_MS = 45000;

  let port = null;
  let nextId = 1;
  /** id -> { resolve, onProgress, timer } */
  const pending = new Map();

  function settle(id, value) {
    const entry = pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.resolve(value);
  }

  function armIdleTimer(id) {
    const entry = pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      settle(id, { delivered: false, error: 'timeout' });
    }, IDLE_TIMEOUT_MS);
  }

  function connect() {
    if (port) return port;
    try {
      port = chrome.runtime.connect({ name: 'ua-scan-client' });
    } catch (error) {
      port = null;
      return null;
    }

    port.onMessage.addListener((message) => {
      if (!message || !message.type) return;

      if (message.type === 'UA_AVAILABLE_RESULT') {
        const entry = pending.get('available');
        if (entry) { pending.delete('available'); clearTimeout(entry.timer); entry.resolve(!!message.available); }
        return;
      }

      if (message.type === 'UA_SCAN_PROGRESS') {
        const entry = pending.get(message.id);
        if (!entry) return;
        armIdleTimer(message.id);
        if (entry.onProgress && message.progress) entry.onProgress(message.progress);
        return;
      }

      if (message.type === 'UA_SCAN_RESULT') {
        settle(message.id, message.delivered
          ? { delivered: true, result: message.result }
          : { delivered: false, error: message.error });
      }
    });

    port.onDisconnect.addListener(() => {
      port = null;
      // Whatever was in flight has nowhere to land; release the callers so they can fall back.
      for (const id of [...pending.keys()]) {
        settle(id, id === 'available' ? false : { delivered: false, error: 'disconnected' });
      }
    });

    return port;
  }

  /** Whether at least one Instagram tab is currently connected. */
  function isPageAvailable() {
    const p = connect();
    if (!p) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { pending.delete('available'); resolve(false); }, 1500);
      pending.set('available', { resolve, timer });
      try { p.postMessage({ type: 'UA_AVAILABLE' }); }
      catch (error) { clearTimeout(timer); pending.delete('available'); resolve(false); }
    });
  }

  /**
   * Run one read inside an Instagram tab.
   * @returns {Promise<{delivered: boolean, result?: object, error?: string}>}
   *          `delivered: false` means nothing was read there — not that the list is empty.
   */
  function runScanInPage({ userId, listType, mode, onProgress }) {
    const p = connect();
    if (!p) return Promise.resolve({ delivered: false, error: 'no port' });

    const id = 'scan-' + (nextId++);
    return new Promise((resolve) => {
      pending.set(id, { resolve, onProgress, timer: null });
      armIdleTimer(id);
      try {
        // `mode` is optional and absent means the two-list read, so an older page script — one
        // still injected in a tab opened before an update — behaves exactly as it did before.
        p.postMessage({ type: 'UA_SCAN_REQUEST', id, userId, listType, mode });
      } catch (error) {
        settle(id, { delivered: false, error: 'send failed' });
      }
    });
  }

  window.UnfollowPageBridge = { isPageAvailable, runScanInPage };
})();
