(function () {
  'use strict';
  if (window !== window.top || window.FloatShellSecurity || !window.FloatShellHandshake || !window.FloatShellRpc) return;
  const handshake = window.FloatShellHandshake;
  const rpc = window.FloatShellRpc;
  let ready = false;
  handshake.onmessage = function (event) {
    if (ready) return;
    const packet = JSON.parse(event.data);
    if (typeof packet.token !== 'string' || !packet.methods) return;
    const token = packet.token; // Closure only: never stored on window, DOM, or storage.
    const invoke = function (namespace, method, args) {
      const result = JSON.parse(rpc.invoke(token, namespace, method, JSON.stringify(args)));
      if (!result.ok) throw new Error(result.error || '设备操作失败。');
      return result.value;
    };
    for (const namespace of ['AndroidShell', 'PhoneWidget']) {
      const api = Object.create(null);
      for (const method of packet.methods[namespace] || []) {
        api[method] = function () { return invoke(namespace, method, Array.from(arguments)); };
      }
      Object.defineProperty(window, namespace, { value: Object.freeze(api), configurable: false, writable: false });
    }
    Object.defineProperty(window, 'FloatShellSecurity', { value: Object.freeze({
      configure: function (policy) { return invoke('Policy', 'configure', [policy]); }
    }), configurable: false, writable: false });
    ready = true;
    window.dispatchEvent(new Event('float-shell-ready'));
  };
  handshake.postMessage('hello');
})();
