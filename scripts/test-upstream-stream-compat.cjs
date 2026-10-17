// Real transport helpers with synthetic responses; no network or model calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const quiet = { log() {}, warn() {}, error() {} };
function evaluate(source, dependencies = {}, globals = {}) {
  const exports = {};
  const compiled = ts.transpileModule(source, { reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  assert.equal((compiled.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
  vm.runInNewContext(compiled.outputText, { exports, require: name => dependencies[name] || {}, console: quiet, TextDecoder, ...globals });
  return exports;
}
const load = (file, dependencies, globals) => evaluate(fs.readFileSync(file, 'utf8'), dependencies, globals);
function extract(file, names) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  return source.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)
    || ts.isVariableStatement(node) && node.declarationList.declarations.some(d => names.includes(d.name.getText(source))))
    .map(node => node.getText(source)).join('\n');
}
const logs = [];
const api = load('lib/api-helpers.ts', { './api-log-store': { pushApiLog: log => logs.push(log) } });
const adapter = load('lib/llm-provider-adapter.ts', { './api-helpers': api });
const sse = load('lib/sse-json.ts');
const messages = [{ role: 'user', content: 'test content' }];
const options = { temperature: .3, max_tokens: 1000 };
const event = object => `data: ${JSON.stringify(object)}\n\n`;
function response(text, fail = false) {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return { ok: true, body: { getReader: () => ({ async read() {
    if (i < bytes.length) { const value = bytes.slice(i, i + 7); i += 7; return { value, done: false }; }
    if (fail) throw new Error('synthetic disconnect');
    return { done: true };
  } }) } };
}
async function main() {
  for (const [provider, frames] of [
    ['OpenAI', [{ choices: [{ delta: { content: '你好' }, finish_reason: 'stop' }] }]],
    ['Anthropic', [{ type: 'content_block_delta', delta: { type: 'text_delta', text: '你好' } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }]],
    ['Google', [{ candidates: [{ content: { parts: [{ text: '你好' }] }, finishReason: 'STOP' }] }]],
  ]) {
    const config = { provider, defaultModel: 'test', apiKey: 'fake-local-test-key' };
    const normal = api.buildSimpleLLMRequest(config, messages, options);
    const stream = api.buildSimpleLLMRequest(config, messages, options, true);
    const streamBody = JSON.parse(stream.body); delete streamBody.stream;
    assert.deepEqual(streamBody, JSON.parse(normal.body), `${provider}: same parameters and messages`);
    let fallback = 0, calls = 0;
    const helper = load('lib/simple-llm-stream.ts', {
      './api-helpers': { ...api, simpleLLMCall: async () => { fallback++; return { content: 'fallback' }; } },
      './api-log-store': { pushApiLog: log => logs.push(log) },
      './llm-provider-adapter': adapter, './sse-json': sse,
    }, { fetch: async () => { calls++; return response(frames.map(event).join('')); } });
    assert.equal((await helper.simpleLLMCallPreferStream(config, messages, options)).content, '你好');
    assert.equal(calls, 1); assert.equal(fallback, 0);
  }
  for (const scenario of ['unsupported', 'partial', 'reasoning', 'cancelled']) {
    let fallback = 0;
    const controller = new AbortController();
    if (scenario === 'cancelled') controller.abort();
    const helper = load('lib/simple-llm-stream.ts', {
      './api-helpers': { ...api, simpleLLMCall: async () => { fallback++; return { content: 'fallback' }; } },
      './api-log-store': { pushApiLog() {} }, './llm-provider-adapter': adapter, './sse-json': sse,
    }, { fetch: async () => {
      if (scenario === 'unsupported') return { ok: false };
      if (scenario === 'cancelled') throw new Error('cancelled');
      return response(event({ choices: [{ delta: scenario === 'reasoning' ? { reasoning_content: 'test' } : { content: 'partial' } }] }), true);
    } });
    const result = await helper.simpleLLMCallPreferStream({ provider: 'OpenAI', apiKey: 'fake', defaultModel: 'test' }, messages, { signal: controller.signal });
    assert.equal(fallback, scenario === 'unsupported' ? 1 : 0, scenario);
    assert.equal(result.content, scenario === 'unsupported' ? 'fallback' : null);
  }
  const wrapperSource = extract('lib/chat-engine.ts', ['sendLLMRequestPreferStream']);
  for (const scenario of ['success', 'unsupported', 'partial', 'reasoning', 'cancelled']) {
    let fallback = 0, receivedReasoning = '';
    const controller = new AbortController();
    if (scenario === 'cancelled') controller.abort();
    const wrapper = evaluate(wrapperSource, {}, {
      sendLLMRequest: async () => { fallback++; return 'fallback'; },
      sendLLMStreamRequest: async (_c, _p, _m, _r, _meta, opts, callbacks) => {
        assert.equal(opts.signal, controller.signal);
        assert.equal(opts.includeReasoning, true);
        if (scenario === 'partial') callbacks.onDelta?.('partial');
        if (scenario === 'reasoning' || scenario === 'success') callbacks.onReasoningDelta('test-reasoning');
        // Protocol fallback now belongs to sendLLMStreamRequest, tested separately
        // against real transport helpers in test-preset-streaming.cjs.
        if (scenario === 'unsupported') { fallback++; return {content:'fallback'}; }
        if (scenario !== 'success') throw new Error('synthetic error');
        return { content: 'complete' };
      },
    });
    const run = () => wrapper.sendLLMRequestPreferStream({}, null, messages, [], {}, {
      signal: controller.signal, includeReasoning: true, onReasoning: text => { receivedReasoning = text; },
    });
    if (['partial', 'reasoning', 'cancelled'].includes(scenario)) await assert.rejects(run);
    else assert.equal(await run(), scenario === 'success' ? 'complete' : 'fallback');
    assert.equal(fallback, scenario === 'unsupported' ? 1 : 0);
    if (scenario === 'success') assert.equal(receivedReasoning, 'test-reasoning');
  }
  const filterSource = extract('lib/qa-agent-engine.ts', ['QA_SEGMENT_MARKER_RE', 'QA_DIRECTIVE_START', 'QA_THINK_START', 'QA_THINK_END', 'NOT_A_BLOCK', 'createQaStreamFilter']);
  const filterModule = evaluate(`${filterSource}\nexports.createFilter = createQaStreamFilter;`);
  for (const [input, expected] of [
    ['文中提到 `<think>` 标签，后文保留。', '文中提到 `<think>` 标签，后文保留。'],
    ['说明 `[执行动作: 写入]` 然后继续。', '说明 `[执行动作: 写入]` 然后继续。'],
    ['前<think>内部测试</think>后', '前后'],
    ['前[获取指令:xxx]后', '前后'],
    ['前[执行动作:写入({"x":"a)]b"})]后', '前后'],
  ]) {
    for (const size of [1, 7, input.length]) {
      let actual = '';
      const filter = filterModule.createFilter(text => { actual += text; });
      for (let i = 0; i < input.length; i += size) await filter.push(input.slice(i, i + size));
      await filter.flush();
      assert.equal(actual, expected);
    }
  }
  console.log('PASS: real simple SSE path for three providers; request equivalence, partial/cancelled no retry, chat wrapper fallback, QA literal tags and real directives. No network/model calls.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
