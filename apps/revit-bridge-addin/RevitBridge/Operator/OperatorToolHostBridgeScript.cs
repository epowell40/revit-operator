namespace RevitBridge.Operator
{
    internal static class OperatorToolHostBridgeScript
    {
        public static string Script => @"
(function () {
  if (window.OperatorToolHost) return;
  const PROTO = 'operator.toolhost.v1';
  const pending = new Map();
  const listeners = new Set();
  let lastMessage = null;

  function emit(msg) {
    lastMessage = msg;
    listeners.forEach(fn => {
      try { fn(msg); } catch (_) { }
    });
    try {
      window.dispatchEvent(new CustomEvent('operator-toolhost-message', { detail: msg }));
    } catch (_) { }
  }

  function nextId() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    } catch (_) { }
    return 'toolhost_' + Date.now() + '_' + Math.floor(Math.random() * 1000000);
  }

  window.OperatorToolHost = {
    protocol: PROTO,
    request: function (type, payload) {
      const id = nextId();
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve: resolve, reject: reject });
        if (!window.chrome || !window.chrome.webview) {
          pending.delete(id);
          reject(new Error('WebView2 host bridge is unavailable.'));
          return;
        }
        window.chrome.webview.postMessage({ version: PROTO, id: id, type: type, payload: payload || {} });
      });
    },
    close: function () {
      return this.request('host.close', {});
    },
    ping: function () {
      return this.request('host.ping', {});
    },
    getInitPayload: function () {
      return this.request('host.getInitPayload', {});
    },
    getLastMessage: function () {
      return lastMessage;
    },
    onMessage: function (fn) {
      if (typeof fn !== 'function') return function () { };
      listeners.add(fn);
      return function () { listeners.delete(fn); };
    }
  };

  if (window.chrome && window.chrome.webview && typeof window.chrome.webview.addEventListener === 'function') {
    window.chrome.webview.addEventListener('message', function (ev) {
      const msg = ev && ev.data;
      if (!msg || msg.version !== PROTO) return;
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.payload);
        else p.reject(new Error(msg.error || 'Host request failed.'));
      }
      emit(msg);
    });
  }
})();
";
    }
}
