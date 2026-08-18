/**
 * Relay between an Instagram page and the extension.
 *
 * The analyzer runs in its own tab and cannot reach this one: that would need the "tabs"
 * permission, which this extension does not request and should not start requesting. So the
 * connection is opened from this end — the content script dials the background, the background
 * holds the port, and a tab announces itself simply by existing.
 *
 * Two hops, because a content script shares the DOM with the page but not its JavaScript context:
 *   page  <-- window.postMessage -->  content script  <-- port -->  background  -->  analyzer
 */
(function () {
  'use strict';

  const PORT_NAME = 'ua-scan-page';
  const REQUEST = 'UA_SCAN_REQUEST';
  const FROM_PAGE = ['UA_SCAN_PROGRESS', 'UA_SCAN_RESULT', 'UA_SCAN_READY'];
  const RECONNECT_DELAY_MS = 2000;

  // The reader has to run in the page's own context to inherit its origin, and a content script
  // cannot reach that context directly — hence a script tag rather than an import.
  for (const file of ['unfollow-bridge.js', 'ig-inject.js']) {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL(file);
    script.async = false;              // preserves order: the bridge must define itself first
    (document.head || document.documentElement).appendChild(script);
  }

  let port = null;

  function connect() {
    try {
      port = chrome.runtime.connect({ name: PORT_NAME });
    } catch (error) {
      // The extension is reloading or shutting down; try again shortly.
      port = null;
      setTimeout(connect, RECONNECT_DELAY_MS);
      return;
    }

    port.onMessage.addListener((message) => {
      if (message && message.type === REQUEST) window.postMessage(message, '*');
    });

    // Service workers are evicted when idle, which drops the port. Reconnecting keeps this tab
    // available for the next scan instead of quietly falling out of the pool.
    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(connect, RECONNECT_DELAY_MS);
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const message = event.data;
    if (!message || FROM_PAGE.indexOf(message.type) === -1) return;
    if (!port) return;
    try {
      port.postMessage(message);
    } catch (error) {
      port = null;
    }
  });

  connect();
})();
