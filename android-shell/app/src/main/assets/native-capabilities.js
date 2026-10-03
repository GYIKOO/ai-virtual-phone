(() => {
    if (window !== window.top || !window.FloatNative || window.FloatNativeClient) return;
    let sequence = 0;
    const pending = new Map();
    FloatNative.onmessage = event => {
        const result = JSON.parse(event.data);
        const handler = pending.get(result.id);
        if (!handler) return;
        pending.delete(result.id);
        clearTimeout(handler.timer);
        if (result.error) handler.reject(new Error(result.error));
        else handler.resolve(result.value);
    };
    function request(op, args = {}) {
        return new Promise((resolve, reject) => {
            const id = String(++sequence);
            // The system picker/permission dialog may stay open as long as the user needs.
            const timer = ['begin', 'requestPermission'].includes(op) ? null : setTimeout(() => {
                pending.delete(id); reject(new Error('APK 未响应，请重试'));
            }, 30000);
            pending.set(id, { resolve, reject, timer });
            FloatNative.postMessage(JSON.stringify({ ...args, op, id }));
        });
    }
    const client = window.FloatNativeClient = {
        permissionGranted: false,
        request,
        async downloadBlob(blob, name) {
            const token = await request('begin', { name, mime: blob.type, size: blob.size });
            try {
                for (let offset = 0; offset < blob.size; offset += 192 * 1024) {
                    const bytes = new Uint8Array(await blob.slice(offset, offset + 192 * 1024).arrayBuffer());
                    let binary = '';
                    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
                    await request('chunk', { token, data: btoa(binary) });
                }
                await request('finish', { token });
            } catch (error) {
                await request('abort', { token }).catch(() => {});
                throw error;
            }
        },
        async downloadUrl(url, name) {
            const response = await fetch(url);
            if (!response.ok) throw new Error('读取下载文件失败');
            await client.downloadBlob(await response.blob(), name || 'download');
        },
    };
    function refreshPermission() {
        request('permission').then(value => { client.permissionGranted = value; }).catch(() => {});
    }
    refreshPermission();
    window.addEventListener('focus', refreshPermission);
    document.addEventListener('visibilitychange', refreshPermission);
    function intercept(anchor) {
        if (!anchor || !anchor.hasAttribute('download') || !/^(blob:|data:)/.test(anchor.href)) return false;
        client.downloadUrl(anchor.href, anchor.download).catch(error => alert(error.message));
        return true;
    }
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
        if (!intercept(this)) originalClick.call(this);
    };
    document.addEventListener('click', event => {
        const anchor = event.target instanceof Element ? event.target.closest('a') : null;
        if (intercept(anchor)) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, true);
})();
