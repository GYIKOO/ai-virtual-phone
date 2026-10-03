// No Android device required: exercise the actual injected client's bridge protocol.
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const assert = require('node:assert/strict');
const source = readFileSync('android-shell/app/src/main/assets/native-capabilities.js', 'utf8');

function harness({ cancel = false, failChunk = false } = {}) {
    const calls = [], chunks = [], errors = [];
    class Anchor { click() {} }
    const window = { addEventListener() {} };
    window.top = window;
    const bridge = { postMessage(raw) {
        const message = JSON.parse(raw);
        calls.push(message);
        let value = true, error;
        if (message.op === 'begin') { value = 'save-token'; if (cancel) error = '已取消保存'; }
        if (message.op === 'chunk') {
            if (failChunk) error = '磁盘空间不足';
            else chunks.push(Buffer.from(message.data, 'base64'));
        }
        queueMicrotask(() => bridge.onmessage({ data: JSON.stringify({ id: message.id, value, error }) }));
    } };
    window.FloatNative = bridge;
    const context = { window, FloatNative: bridge, HTMLAnchorElement: Anchor, Element: class {},
        document: { addEventListener() {} }, Uint8Array, Blob, Map, JSON, Error,
        setTimeout, clearTimeout, fetch, btoa, alert: message => errors.push(message) };
    runInNewContext(source, context);
    return { client: window.FloatNativeClient, calls, chunks, errors, context };
}

(async () => {
    const sample = Buffer.alloc(600001);
    for (let i = 0; i < sample.length; i++) sample[i] = i % 256;
    const good = harness();
    await good.client.downloadBlob(new Blob([sample], { type: 'application/zip' }), '备份.zip');
    assert.deepEqual(Buffer.concat(good.chunks), sample);
    assert.equal(good.calls.filter(c => c.op === 'chunk').length, 4);
    assert.equal(good.calls.at(-1).op, 'finish');
    assert.equal(good.calls.find(c => c.op === 'begin').name, '备份.zip');
    assert.equal(good.calls.find(c => c.op === 'begin').size, sample.length);
    assert.ok(good.calls.filter(c => c.op === 'chunk').every(c => c.token === 'save-token'));
    runInNewContext(source, good.context); // reinjection must not install duplicate listeners
    assert.equal(good.context.window.FloatNativeClient, good.client);

    const empty = harness();
    await empty.client.downloadBlob(new Blob([]), 'empty.txt');
    assert.equal(empty.calls.filter(c => c.op === 'chunk').length, 0);
    assert.equal(empty.calls.at(-1).op, 'finish');

    const cancelled = harness({ cancel: true });
    await assert.rejects(cancelled.client.downloadBlob(new Blob(['x']), 'cancel.txt'), /已取消保存/);
    assert.ok(!cancelled.calls.some(c => ['chunk', 'finish'].includes(c.op)));
    const failed = harness({ failChunk: true });
    await assert.rejects(failed.client.downloadBlob(new Blob(['x']), 'failed.txt'), /磁盘空间不足/);
    assert.equal(failed.calls.at(-1).op, 'abort');
    assert.ok(!failed.calls.some(c => c.op === 'finish'));
    assert.equal(await good.client.request('permission'), true);
    await good.client.request('notify', { title: '角色', body: '消息' });
    assert.equal(good.calls.at(-1).body, '消息');
    console.log('PASS: chunk integrity, filename, empty files, cancellation, failure cleanup, reinjection and notification protocol');
})().catch(error => { console.error(error); process.exitCode = 1; });
