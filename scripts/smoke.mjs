#!/usr/bin/env node

/**
 * Smoke test against the live Sleeper API through a real MCP stdio session.
 * Usage: node scripts/smoke.mjs <tool_name> '<json args>'
 * With no arguments, lists tools and calls get_nfl_state.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, "..", "dist", "index.js");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: { ...process.env },
});
const client = new Client(
  { name: "smoke-test", version: "1.0.0" },
  { capabilities: {} },
);

await client.connect(transport);

const [toolName = "get_nfl_state", rawArgs = "{}"] = process.argv.slice(2);

if (process.argv.length <= 2) {
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
