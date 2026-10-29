#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { tools, execute, VERSION } from '../src/tools.mjs';
import { errorResult } from '../src/errors.mjs';
import { closeLiveSessions } from '../src/live.mjs';

const server = new McpServer({ name: 'abox-tools', version: VERSION });
for (const tool of tools) {
  server.registerTool(tool.name, {
    title: tool.title, description: tool.description, inputSchema: tool.schema.shape,
    annotations: {
      readOnlyHint: Boolean(tool.readOnly), destructiveHint: false,
      idempotentHint: Boolean(tool.readOnly), openWorldHint: Boolean(tool.openWorld),
    },
  }, async (args, extra) => {
    try {
      const result = await execute(tool.name, args, { signal: extra.signal });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      const result = errorResult(error);
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
  });
}

await server.connect(new StdioServerTransport());
process.stdin.once('end', () => { void closeLiveSessions(); });
for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => { void closeLiveSessions().finally(() => process.exit(event === 'SIGINT' ? 130 : 143)); });
