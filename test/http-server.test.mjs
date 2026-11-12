/**
 * Offline tests for the HTTP MCP endpoint (claude.ai / phone connector).
 * Uses the real MCP SDK client over HTTP; only network-free tools are called.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  createMcpHttpServer,
  generateSecret,
  MIN_SECRET_LENGTH,
} from "../dist/http-server.js";

const secret = generateSecret();
let server;
let base;

before(async () => {
  server = createMcpHttpServer({ secret });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function connect(path = `/mcp/${secret}`) {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + path)));
  return client;
}

test("generated secrets are long and random", () => {
  const a = generateSecret();
  assert.ok(a.length >= MIN_SECRET_LENGTH);
  assert.notEqual(a, generateSecret());
  assert.match(a, /^[A-Za-z0-9_-]+$/); // safe in a URL path
});

test("refuses to start without a strong secret", () => {
  assert.throws(() => createMcpHttpServer({ secret: "" }), /MCP_HTTP_SECRET/);
  assert.throws(() => createMcpHttpServer({ secret: "short" }), /at least/);
});

test("MCP client can initialize and list all tools over HTTP", async () => {
  const client = await connect();
  assert.equal(client.getServerVersion().name, "sleeper-mcp");
  const { tools } = await client.listTools();
  assert.equal(tools.length, 23);
  assert.ok(tools.some((t) => t.name === "find_trade_partners"));
  await client.close();
});

test("tool calls work over HTTP", async () => {
  const client = await connect();
  const result = await client.callTool({
    name: "clear_cache",
    arguments: { confirm: false },
  });
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.success, false);
  assert.match(payload.error, /confirmation/);
  await client.close();
});

test("trailing slash on the endpoint is accepted", async () => {
  const client = await connect(`/mcp/${secret}/`);
  assert.equal((await client.listTools()).tools.length, 23);
  await client.close();
});

test("wrong or missing secret looks like nothing is there", async () => {
  for (const path of ["/mcp", "/mcp/", `/mcp/${secret}x`, "/mcp/nope", "/"]) {
    const res = await fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 404, path);
  }
  await assert.rejects(connect("/mcp/wrong"));
});

test("health check needs no secret and reveals nothing", async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("GET and DELETE are 405 (stateless server)", async () => {
  for (const method of ["GET", "DELETE"]) {
    const res = await fetch(`${base}/mcp/${secret}`, { method });
    assert.equal(res.status, 405, method);
  }
});

test("malformed and oversized bodies are rejected", async () => {
  const bad = await fetch(`${base}/mcp/${secret}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not json",
  });
  assert.equal(bad.status, 400);

  const huge = await fetch(`${base}/mcp/${secret}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pad: "x".repeat(1024 * 1024 + 10) }),
  }).catch(() => null); // server may cut the connection instead
  if (huge) assert.equal(huge.status, 413);
});
