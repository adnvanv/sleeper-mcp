#!/usr/bin/env node

/**
 * HTTP entry point (MCP "Streamable HTTP" transport) so the tools can be used
 * as a claude.ai custom connector, which also makes them available in the
 * Claude phone app. Run it behind Tailscale Funnel (or another HTTPS proxy).
 *
 *   MCP_HTTP_SECRET=<long random string> npm run mcp:http
 *
 * The only MCP endpoint is /mcp/<secret>. Every other path returns 404, so the
 * server is invisible without the secret. Stateless: each POST gets a fresh
 * MCP server and transport, so there is no session state to leak or expire.
 */

import { createServer, type IncomingMessage, type Server } from "http";
import { randomBytes, timingSafeEqual } from "crypto";
import { pathToFileURL } from "url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./mcp-server.js";

const MAX_BODY_BYTES = 1024 * 1024;
export const MIN_SECRET_LENGTH = 24;

export function generateSecret(): string {
  return randomBytes(24).toString("base64url");
}

function secretMatches(candidate: string, secret: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

const jsonRpcError = (code: number, message: string) =>
  JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null });

export interface McpHttpOptions {
  secret: string;
}

export function createMcpHttpServer({ secret }: McpHttpOptions): Server {
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `MCP_HTTP_SECRET must be at least ${MIN_SECRET_LENGTH} characters`,
    );
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const send = (status: number, body: string, type = "application/json") => {
      if (res.headersSent) return;
      res.writeHead(status, { "Content-Type": type });
      res.end(body);
    };

    if (url.pathname === "/health") {
      return send(200, JSON.stringify({ ok: true }));
    }

    const match = /^\/mcp\/([^/]+)\/?$/.exec(url.pathname);
    if (!match || !secretMatches(match[1], secret)) {
      return send(404, JSON.stringify({ error: "Not found" }));
    }

    // Stateless server: no SSE stream (GET) or session teardown (DELETE)
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return send(405, jsonRpcError(-32000, "Method not allowed"));
    }

    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch (error) {
      const tooLarge = error instanceof Error && error.message === "too large";
      return send(
        tooLarge ? 413 : 400,
        jsonRpcError(-32700, tooLarge ? "Request too large" : "Parse error"),
      );
    }

    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      console.error(
        "[mcp-http] request failed:",
        error instanceof Error ? error.message : error,
      );
      send(500, jsonRpcError(-32603, "Internal server error"));
    }
  });
}

async function main() {
  const { config } = await import("./config.js");

  if (
    !config.mcpHttpSecret ||
    config.mcpHttpSecret.length < MIN_SECRET_LENGTH
  ) {
    console.error(
      `MCP_HTTP_SECRET is missing or shorter than ${MIN_SECRET_LENGTH} characters.\n` +
        `Add this line to .env (a fresh random value):\n\n` +
        `MCP_HTTP_SECRET=${generateSecret()}\n`,
    );
    process.exit(1);
  }
  if (!config.username) {
    console.error(
      "Warning: SLEEPER_USERNAME is not set, so tools won't know whose team is yours.",
    );
  }

  const server = createMcpHttpServer({ secret: config.mcpHttpSecret });
  server.on("error", (error: NodeJS.ErrnoException) => {
    console.error(
      error.code === "EADDRINUSE"
        ? `Port ${config.mcpHttpPort} is in use. Set MCP_HTTP_PORT to another port.`
        : `MCP HTTP server error: ${error.message}`,
    );
    process.exit(1);
  });
  server.listen(config.mcpHttpPort, config.mcpHttpHost, () => {
    console.error(
      `Sleeper MCP (HTTP) listening on http://${config.mcpHttpHost}:${config.mcpHttpPort}/mcp/<secret>`,
    );
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
