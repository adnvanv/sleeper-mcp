#!/usr/bin/env node

/**
 * Smoke test against the live Sleeper API through a real MCP session.
 *
 *   node scripts/smoke.mjs [tool_name] ['<json args>']
 *   node scripts/smoke.mjs --url https://host/mcp/<secret> [tool_name] ['<json args>']
 *
 * Without --url it starts the stdio server (like Claude Desktop does). With
 * --url it connects to a running HTTP endpoint (like claude.ai does).
 * With no tool name, it lists tools and calls get_nfl_state.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, "..", "dist", "index.js");

const argv = process.argv.slice(2);
let url;
if (argv[0] === "--url") {
  url = argv[1];
  argv.splice(0, 2);
}

const transport = url
  ? new StreamableHTTPClientTransport(new URL(url))
  : new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      env: { ...process.env },
    });
const client = new Client({ name: "smoke-test", version: "1.0.0" });

await client.connect(transport);

const [toolName = "get_nfl_state", rawArgs = "{}"] = argv;

if (argv.length === 0) {
  const { tools } = await client.listTools();
  console.log(
    `Tools (${tools.length}): ${tools.map((t) => t.name).join(", ")}`,
  );
}

const result = await client.callTool({
  name: toolName,
  arguments: JSON.parse(rawArgs),
});
console.log(result.content[0].text);

await client.close();
