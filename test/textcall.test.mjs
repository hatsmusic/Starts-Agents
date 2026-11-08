import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTextToolCall, couldBeTextCall } from '../src/engines.js';
import { TOOLS } from '../src/tools.js';

test('prefix-form text call is parsed', () => {
  const c = parseTextToolCall('run_shell{"command":"echo hi"}');
  assert.equal(c.name, 'run_shell');
  assert.deepEqual(c.args, { command: 'echo hi' });
});
test('prefix form after prose on its own line is parsed', () => {
  const c = parseTextToolCall('好的，我来执行。\nwrite_file{"path":"a.txt","content":"x"}');
  assert.equal(c.name, 'write_file');
});
test('JSON object form still parses', () => {
  const c = parseTextToolCall('{"name":"read_file","arguments":{"path":"a.txt"}}');
  assert.equal(c.name, 'read_file');
});
test('prose quoting an example is NOT a call', () => {
  assert.equal(parseTextToolCall('read_file 是读文件的工具，举个例子 { "path": "a.txt" } 这样写。'), null);
  assert.equal(parseTextToolCall('执行 run_shell{"command":"ls"} 之后记得看输出'), null);
  assert.equal(parseTextToolCall('just a normal answer'), null);
});
test('unknown tool names are not calls', () => {
  assert.equal(parseTextToolCall('fly_away{"speed":3}'), null);
});
test('couldBeTextCall holds call-shaped line starts only', () => {
  assert.equal(couldBeTextCall('run_sh'), true);
  assert.equal(couldBeTextCall('run_shell{'), true);
  assert.equal(couldBeTextCall('{"name":'), true);
  assert.equal(couldBeTextCall('read_file 是个工具'), false);
  assert.equal(couldBeTextCall('今天我们来聊聊'), false);
});
test('ask_teammate exists and refuses without a delegation context', async () => {
  const tool = TOOLS.find((x) => x.name === 'ask_teammate');
  assert.ok(tool);
  await assert.rejects(() => tool.run({ bot: 'X', task: 'y' }, {}), /not available/);
});
