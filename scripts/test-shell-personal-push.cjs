// Offline only: execute actual TS gateway/client code with fake bridge and HTTP.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { webcrypto, randomUUID } = require('node:crypto');
const deviceId = randomUUID() + randomUUID();
const project = 'https://test-project.supabase.co';
const compile = file => ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

async function testGateway() {
    let handler;
    const calls = [];
    const env = { SUPABASE_URL: project, SUPABASE_SERVICE_ROLE_KEY: 'admin-test-key', SUPABASE_ANON_KEY: 'public-test-key' };
    const context = {
        exports: {}, Request, Response, URL, URLSearchParams, TextEncoder, TextDecoder, Uint8Array,
        crypto: webcrypto, btoa, atob, console,
        setTimeout: fn => { queueMicrotask(fn); return 1; }, clearTimeout() {},
        Deno: { env: { get: key => env[key] }, serve: fn => { handler = fn; } },
        fetch: async (url, init = {}) => {
            calls.push({ url, ...init });
            if (url.includes('/auth/v1/admin/')) return new Response('{}', { status: 401 });
            if (url.includes('/rest/v1/push_server_config')) return Response.json([{
                vapid_public_key: 'public', vapid_private_key: 'private', cron_secret: 'cron', payload_key: 'payload',
            }]);
            if (url.includes('/rest/v1/push_subscriptions')) return Response.json([{ endpoint: `shell:device:${deviceId}`, p256dh: 'shell', auth: 'shell' }]);
            if (url.includes('/realtime/v1/api/broadcast')) return new Response('', { status: 202 });
            throw new Error(`Unexpected HTTP: ${url}`);
        },
    };
    vm.runInNewContext(compile('supabase/functions/ai-phone-push/index.ts'), context);
    const request = (action, body, authorized = true) => handler(new Request(`${project}/functions/v1/ai-phone-push?action=${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorized ? { 'x-ai-phone-service-key': env.SUPABASE_SERVICE_ROLE_KEY } : {}) },
        body: JSON.stringify(body),
    }));
    assert.equal((await request('shell-subscribe', { deviceId }, false)).status, 401);
    assert.equal((await request('shell-subscribe', { deviceId: 'owner' })).status, 400);
    const result = await (await request('shell-subscribe', { deviceId })).json();
    assert.equal(result.ok, true);
    assert.equal(result.config.anonKey, env.SUPABASE_ANON_KEY);
    assert.equal(result.config.channelId, `device:${deviceId}`);
    assert.ok(!JSON.stringify(result).includes(env.SUPABASE_SERVICE_ROLE_KEY));
    const stored = JSON.parse(calls.find(c => c.method === 'POST' && c.url.includes('on_conflict=endpoint')).body)[0];
    assert.equal(stored.user_id, 'owner');
    assert.equal(stored.endpoint, `shell:device:${deviceId}`);
    const test = await (await request('test', {})).json();
    assert.equal(test.ok, true);
    const broadcast = calls.find(c => c.url.includes('/realtime/v1/api/broadcast'));
    assert.equal(JSON.parse(broadcast.body).messages[0].topic, `shellpush:device:${deviceId}`);
    assert.ok(!calls.some(c => c.url.startsWith('shell:')));
    delete env.SUPABASE_ANON_KEY;
    assert.equal((await request('shell-subscribe', { deviceId })).status, 503);
}

async function testClient() {
    let active = true, currentUrl = project, permission = true, oldApk = false, registered = true;
    let bridgeStatus = { deviceId, url: project, configured: false, connected: false, permission: true };
    const nativeCalls = [], cloudCalls = [];
    const native = { request: async (op, args) => {
        nativeCalls.push({ op, args });
        if (oldApk) throw new Error('unsupported operation');
        if (op === 'personalPushStatus') return { ...bridgeStatus };
        if (op === 'requestPermission') return permission;
        if (op === 'configurePersonalPush') { bridgeStatus.configured = Boolean(args.config); return true; }
        throw new Error(op);
    } };
    const cloud = {
        isPersonalPushCloudActive: () => active,
        loadPersonalPushCloudState: () => ({ url: currentUrl }),
        personalPushFetch: async (action, init) => {
            cloudCalls.push({ action, ...init });
            if (!registered) return Response.json({ ok: false, error: 'test registration failure' }, { status: 500 });
            return Response.json({ ok: true, config: { url: project, anonKey: 'public-key', channelId: `device:${deviceId}` } });
        },
    };
    const exports = {};
    vm.runInNewContext(compile('lib/shell-personal-push.ts'), { exports, require: name => name === './android-native' ? { getAndroidNative: () => native } : cloud });
    await exports.connectShellPersonalPush();
    assert.equal(nativeCalls.at(-1).op, 'configurePersonalPush');
    assert.equal(bridgeStatus.configured, true);
    const before = cloudCalls.length;
    assert.equal(await exports.reconcileShellPersonalPush(), true);
    assert.equal(cloudCalls.length, before); // no polling/API traffic
    currentUrl = 'https://other.supabase.co';
    assert.equal(await exports.reconcileShellPersonalPush(), false);
    assert.equal(bridgeStatus.configured, false);
    currentUrl = project;
    permission = false;
    await assert.rejects(exports.connectShellPersonalPush(), /通知权限/);
    assert.equal(cloudCalls.length, before);
    permission = true;
    registered = false;
    await assert.rejects(exports.connectShellPersonalPush(), /test registration failure/);
    assert.equal(bridgeStatus.configured, false);
    registered = true;
    await exports.disconnectShellPersonalPush();
    const removal = cloudCalls.at(-1);
    assert.equal(removal.method, 'DELETE');
    assert.equal(JSON.parse(removal.body).endpoint, `shell:device:${deviceId}`);
    oldApk = true;
    await assert.rejects(exports.shellPushStatus(), /更新 APK/);
    oldApk = false; active = false;
    await assert.rejects(exports.connectShellPersonalPush(), /先在设置/);
}

async function testDeliveryPaths() {
    const source = fs.readFileSync('supabase/functions/push-generate/index.ts', 'utf8');
    const file = ts.createSourceFile('worker.ts', source, ts.ScriptTarget.Latest, true);
    const fn = file.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'shellPushChannels');
    assert.ok(fn);
    const sandbox = {};
    vm.runInNewContext(ts.transpileModule(fn.getText(file), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
    const second = randomUUID() + randomUUID();
    const channels = sandbox.shellPushChannels([
        { endpoint: `shell:device:${deviceId}` }, { endpoint: `shell:device:${second}` },
        { endpoint: `shell:device:${deviceId}` }, { endpoint: 'shell:legacy-user' },
        { endpoint: 'https://web-push.invalid' },
    ], 'legacy-user');
    assert.deepEqual(Array.from(channels), [`device:${deviceId}`, `device:${second}`, 'legacy-user']);
    assert.match(source, /messages: shellPushChannels\(subs, job.user_id\)/);

    // Exercise the bridge worker's real dispatcher without invoking its job handler.
    const calls = [];
    const ctx = { exports: {}, TextEncoder, TextDecoder, Uint8Array, btoa, atob, crypto: webcrypto,
        Deno: { serve() {}, env: { get: key => key === 'SUPABASE_URL' ? project : 'test-key' } },
        fetch: async (url, init) => { calls.push({ url, init }); return new Response('', { status: 202 }); },
    };
    vm.runInNewContext(compile('supabase/functions/push-bridge/index.ts'), ctx);
    assert.equal(await ctx.sendWebPushRaw({ endpoint: `shell:device:${deviceId}` }, JSON.stringify({ title: '角色', body: '消息' }), {}, 60), 202);
    assert.equal(JSON.parse(calls[0].init.body).messages[0].topic, `shellpush:device:${deviceId}`);
    assert.equal(await ctx.sendWebPushRaw({ endpoint: 'shell:bad' }, '{}', {}, 60), 400);
    assert.equal(calls.length, 1);
}

(async () => {
    await testGateway();
    await testClient();
    await testDeliveryPaths();
    console.log('PASS: authenticated device registration, no admin-key transfer, native test delivery, permission/failure handling, project isolation, per-device unsubscribe and no cloud polling');
})().catch(error => { console.error(error); process.exitCode = 1; });
