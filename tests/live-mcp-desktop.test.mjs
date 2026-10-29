import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const enabled = process.env.ABOX_TEST_LIVE_DESKTOP === '1';
const supplied = process.env.ABOX_TEST_DESKTOP_ADAPTER_ROOT;
const root = supplied ?? fileURLToPath(new URL('../', import.meta.url));
const runtime = supplied ? path.join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node') : process.execPath;

// This optional desktop check uses the real visible-window launcher. It never
// presses Start/Connect or grants camera/microphone permission.
test('real desktop MCP opens, checks and closes all four passive companion tools', { skip: !enabled, timeout: 120000 }, async t => {
  assert.ok(path.isAbsolute(root));
  const transport = new StdioClientTransport({ command: runtime, args: [path.join(root, 'bin/abox-mcp.mjs')], stderr: 'pipe' });
  const client = new Client({ name: 'abox-passive-desktop-check', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, 'The passive MCP operation must succeed.');
    assert.ok(result.structuredContent);
    return result.structuredContent;
  };
  let opened = 0;
  for (const [name, role] of [['abox_share_session', 'host'], ['abox_camera_session', 'viewer'], ['abox_walkie_session', 'listener'], ['abox_voice_oncall_session', 'host']]) {
    const result = await call(name, { role, ttl_minutes: 1 });
    assert.equal(result.browser_opened, true);
    assert.equal(result.phase, 'idle'); assert.equal(result.capture, 'none'); assert.equal(result.connected, false); assert.equal(result.peer_count, 0);
    const status = await call('abox_live_status', { session_id: result.session_id });
    assert.equal(status.phase, 'idle'); assert.equal(status.capture, 'none');
    const stopped = await call('abox_live_stop', { session_id: result.session_id });
    assert.equal(stopped.stopped, true); assert.equal(stopped.capture, 'none');
    opened++;
  }
  assert.deepEqual((await call('abox_live_status', {})).sessions, []);
  assert.equal(opened, 4);
});
