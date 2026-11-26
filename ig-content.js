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

  // Prevent duplicate active relays in the same content-script world
  if (window.__uaContentPortValid && window.__uaContentPortValid()) {
    return;
  }

  // Remove any stale main-world bridge script tags from an older extension version before injecting
  try {
    document.querySelectorAll('script[data-ua-bridge="1"]').forEach((s) => s.remove());
  } catch (e) {}

  const ver = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest)
    ? chrome.runtime.getManifest().version
    : String(Date.now());

  for (const file of ['ig-session.js', 'unfollow-bridge.js', 'ig-inject.js']) {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL(file) + '?v=' + encodeURIComponent(ver);
    script.async = false;
    script.setAttribute('data-ua-bridge', '1');
    (document.head || document.documentElement).appendChild(script);
  }

  let port = null;
  window.__uaContentPortValid = () => !!(port && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);

  function connect() {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
      return; // Extension context invalidated after update/reload; stop reconnecting from orphaned script
    }
    try {
      port = chrome.runtime.connect({ name: PORT_NAME });
    } catch (error) {
      // The extension is reloading or shutting down; try again shortly if context still valid.
      port = null;
      if (chrome.runtime && chrome.runtime.id) {
        setTimeout(connect, RECONNECT_DELAY_MS);
      }
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
