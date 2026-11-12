#!/usr/bin/env node

/**
 * stdio entry point: Claude Desktop starts this process and talks to it over
 * stdin/stdout. For the HTTP version (phone / claude.ai), see http-server.ts.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./mcp-server.js";
import { tools } from "./tools.js";

async function main(): Promise<void> {
  const server = createMcpServer();

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.connect(new StdioServerTransport());
  console.error("Sleeper MCP Server running on stdio");
  console.error("Available tools:", tools.map((t) => t.name).join(", "));
}

main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
