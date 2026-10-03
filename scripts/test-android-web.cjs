const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');

function load(path, context, dependencies) {
    const module = { exports: {} };
    runInNewContext(ts.transpileModule(readFileSync(path, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText, { ...context, module, exports: module.exports, require: name => dependencies[name] });
    return module.exports;
}

(async () => {
    let native, setting = true, clicks = 0, notified = 0;
    const context = {
        window: {}, document: { hidden: true, createElement: () => ({ click() { clicks++; }, remove() {} }), body: { appendChild() {} } },
        navigator: { userAgent: 'Android' }, URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
        setTimeout: callback => { callback(); }, console,
    };
    const dependencies = {
        './android-native': { getAndroidNative: () => native },
        './chat-storage': { loadChatAppSettings: () => ({ browserNotificationsEnabled: setting }) },
    };
    const download = load('lib/download-utils.ts', context, dependencies);
    await download.downloadFile(new Blob(['test']), 'web.txt');
    assert.equal(clicks, 1, 'ordinary browser keeps anchor download');
    let finish;
    native = { permissionGranted: true, downloadBlob: () => new Promise(resolve => { finish = resolve; }) };
    let complete = false;
    const saving = download.downloadFile(new Blob(['test']), 'native.txt').then(() => { complete = true; });
    await Promise.resolve();
    assert.equal(complete, false, 'must wait for actual native save');
    finish(); await saving;
    assert.equal(clicks, 1, 'no duplicate anchor download');
    native.downloadBlob = async () => { throw new Error('已取消保存'); };
    await assert.rejects(download.downloadFile(new Blob(), 'cancel'), /已取消保存/);

    native.request = async op => { if (op === 'notify') notified++; return true; };
    const notifications = load('lib/browser-notification.ts', context, dependencies);
    assert.equal(await notifications.requestNotificationPermission(), true);
    assert.equal(notifications.isNotificationEnabled(), true);
    notifications.sendBrowserNotification('角色', { body: '消息' });
    assert.equal(notified, 1);
    context.document.hidden = false;
    notifications.sendBrowserNotification('visible');
    setting = false; context.document.hidden = true;
    notifications.sendBrowserNotification('disabled');
    setting = true; native.permissionGranted = false;
    notifications.sendBrowserNotification('denied');
    assert.equal(notified, 1, 'foreground, disabled or denied notifications must not send');
    native.request = async () => { throw new Error('bridge failed'); };
    assert.equal(await notifications.requestNotificationPermission(), false);
    console.log('PASS: browser fallback, native save acknowledgement/cancel, native permissions and notification gates');
})().catch(error => { console.error(error); process.exitCode = 1; });
