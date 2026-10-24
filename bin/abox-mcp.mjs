#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { tools, execute, VERSION } from '../src/tools.mjs';
import { errorResult } from '../src/errors.mjs';

const server = new McpServer({ name: 'abox-tools', version: VERSION });
for (const tool of tools) {
  server.registerTool(tool.name, {
    title: tool.title, description: tool.description, inputSchema: tool.schema.shape,
    annotations: {
      readOnlyHint: Boolean(tool.readOnly), destructiveHint: false,
      idempotentHint: Boolean(tool.readOnly), openWorldHint: false,
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
