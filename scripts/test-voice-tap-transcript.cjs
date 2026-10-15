const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const source = fs.readFileSync('components/chat/chat-room.tsx', 'utf8');
const ast = ts.createSourceFile('chat-room.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handler;
function visit(node) {
  if (ts.isJsxAttribute(node) && node.name.getText(ast) === 'onClick'
    && node.initializer?.getText(ast).includes('setVoiceTextIds')) handler = node.initializer.expression;
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(handler, 'voice bar click reveals the existing transcript');
const compiled = ts.transpileModule('click = ' + handler.getText(ast), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const state = new Set();
const context = { msg: { id: 'voice-a' }, renderMsg: { mediaType: 'audio', mediaData: { label: '你好' } }, activeMessageId: null,
  setVoiceTextIds: update => { context.ids = update(context.ids); }, ids: state, Set };
vm.runInNewContext(compiled, context);
const event = inside => ({ target: { closest: selector => { assert.equal(selector, '.voice-msg-bubble'); return inside ? {} : null; } } });
context.click(event(true)); assert.ok(context.ids.has('voice-a'));
const first = context.ids; context.click(event(true)); assert.equal(context.ids, first, 'pause/replay does not collapse text');
context.msg.id = 'voice-b'; context.click(event(false)); assert.ok(!context.ids.has('voice-b'), 'menu/unrelated clicks do not reveal');
context.activeMessageId = 'voice-b'; context.click(event(true)); assert.ok(!context.ids.has('voice-b'), 'context-menu click does not reveal');
context.activeMessageId = null; context.renderMsg.mediaData.label = ''; context.click(event(true)); assert.ok(!context.ids.has('voice-b'));
context.renderMsg.mediaData.label = '文字'; context.renderMsg.mediaType = 'image'; context.click(event(true)); assert.ok(!context.ids.has('voice-b'));
assert.ok(!/ctx-menu-btn[^>]*>转文字/.test(source));
assert.ok(source.includes('voiceTextIds.has(msg.id) && renderMsg.mediaData?.label'));
assert.ok(source.includes('text={msg.displayProjected ? (renderMsg.mediaData?.label || "") : renderDisplayText('), 'existing regex/projected/bilingual display retained');
assert.ok(source.includes('onClickCapture: (e: React.MouseEvent) =>'), 'existing multiselect capture retained');
const bubble = fs.readFileSync('components/chat/message-bubble.tsx', 'utf8');
assert.ok(bubble.includes('className="voice-msg-bubble" onClick={handlePlay}'), 'playback stays on original voice bar handler');
console.log('PASS: actual click handler reveals known transcript, keeps it on pause/replay, skips other media/menu/empty labels; existing playback, bilingual/regex display and multiselect capture retained.');
