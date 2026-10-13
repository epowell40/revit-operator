import assert from 'node:assert/strict';
import test from 'node:test';
import { assertMcpInventoryHandshake } from '../src/codex/mcp_inventory_handshake.js';
import { SUPPORTED_TOOL_INVENTORY_HASH } from '../src/capabilities/supported_tool_inventory.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexMcpToolRuntime } from '../src/codex/mcp_tool_runtime.js';
const result = (payload: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] });
const current = { status: 'ok', protocol: 'operator.mcp.runtime.v1', supportedToolInventory: { hash: SUPPORTED_TOOL_INVENTORY_HASH } };
test('current compiled MCP capability inventory can start', () => assert.doesNotThrow(() => assertMcpInventoryHandshake(result(current))));
test('old compiled peer and missing inventory stop before tool admission', () => {
  for (const hash of [undefined, 'sha256:older-compiled-inventory']) {
    assert.throws(() => assertMcpInventoryHandshake(result({ ...current, supportedToolInventory: { hash } })), /operator_mcp_inventory_mismatch/);
  }
});
test('failed, malformed and ambiguous probes never establish inventory parity', () => {
  for (const probe of [null, {}, { isError: true, ...result(current) }, result({ ...current, protocol: 'other' }),
    { content: [{ type: 'text', text: '{' }] }, { content: [...result(current).content, ...result(current).content] }]) {
    assert.throws(() => assertMcpInventoryHandshake(probe), /operator_mcp_inventory_mismatch/);
  }
});

test('actual backend startup rejects an old compiled MCP before listing or dispatching tools', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-mcp-peer-version-'));
  fs.mkdirSync(path.join(root, 'operator-backend'));fs.mkdirSync(path.join(root, 'mcp-server', 'dist'), { recursive: true });
  const trace = path.join(root, 'calls.jsonl');
  fs.writeFileSync(path.join(root, 'mcp-server', 'package.json'), JSON.stringify({ type: 'module' }));
  fs.writeFileSync(path.join(root, 'mcp-server', 'dist', 'server.js'), `
    import fs from 'node:fs';
    import { McpServer } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/mcp.js'))};
    import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js'))};
    const server=new McpServer({name:'old-compiled-peer',version:'1'});
    server.tool('operator_runtime_probe','Local startup probe',{},async()=>{
      fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify('probe')+'\\n');
      return ${JSON.stringify(result({ ...current, supportedToolInventory: { hash: 'sha256:older-compiled-inventory' } }))};
    });
    server.tool('revit_get_context','Must not dispatch',{},async()=>{throw Error('unexpected Revit dispatch');});
    await server.connect(new StdioServerTransport());
  `);
  const runtime=new CodexMcpToolRuntime({backendCwd:path.join(root,'operator-backend'),workspaceRoot:root,codexHome:root,spawnEnv:{OPERATOR_MCP_TOOL_TIMEOUT_MS:'10000'}});
  try {
    await assert.rejects(runtime.getDynamicToolNamespace(), /operator_mcp_inventory_mismatch/);
    assert.equal(fs.readFileSync(trace,'utf8'), '"probe"\n');
  } finally { runtime.stop();fs.rmSync(root,{recursive:true,force:true}); }
});
