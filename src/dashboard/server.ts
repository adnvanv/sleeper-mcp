#!/usr/bin/env node

/**
 * Local web dashboard for the Sleeper MCP server. Plain node:http, no
 * framework: static files from dashboard/public plus a small JSON API.
 *
 *   npm run dashboard
 *   DASHBOARD_HOST=0.0.0.0 DASHBOARD_PORT=8080 npm run dashboard
 */

import { createServer, type Server } from "http";
import { promises as fs } from "fs";
import { join, dirname, extname, normalize, sep } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = join(__dirname, "..", "..", "dashboard", "public");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data: https://sleepercdn.com; style-src 'self'; script-src 'self'; connect-src 'self'",
};

type PanelFn<C> = (ctx: C, params: URLSearchParams) => Promise<unknown>;

export interface StreamSource {
  /** Current data for every topic, sent when a browser connects. */
  snapshots(): [string, { data: unknown; updated: string }][];
  /** Call listener on every update; returns an unsubscribe function. */
  subscribe(
    listener: (topic: string, snap: { data: unknown; updated: string }) => void,
  ): () => void;
  /** Count an open page (fast polling only runs while someone is watching). */
  addViewer?(): () => void;
}

export interface DashboardOptions<C> {
  panels: Record<string, PanelFn<C>>;
  getContext: () => Promise<C>;
  publicDir?: string;
  /** Live updates pushed to the page at /api/stream (server-sent events). */
  stream?: StreamSource;
}

const MAX_STREAMS = 20;
const HEARTBEAT_MS = 25 * 1000;

export function createDashboardServer<C>(options: DashboardOptions<C>): Server {
  const { panels, getContext, publicDir = PUBLIC_DIR, stream } = options;
  let openStreams = 0;
  let contextPromise: Promise<C> | null = null;
  const context = () => {
    if (!contextPromise) {
      contextPromise = getContext().catch((error) => {
        contextPromise = null; // retry next request
        throw error;
      });
    }
    return contextPromise;
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const send = (
      status: number,
      body: string | Buffer,
      type: string,
      extra: Record<string, string> = {},
    ) => {
      res.writeHead(status, {
        "Content-Type": type,
        ...SECURITY_HEADERS,
        ...extra,
      });
      res.end(req.method === "HEAD" ? undefined : body);
    };
    const json = (status: number, data: unknown) =>
      send(status, JSON.stringify(data), CONTENT_TYPES[".json"], {
        "Cache-Control": "no-store",
      });

    if (req.method !== "GET" && req.method !== "HEAD") {
      return json(405, { error: "Read-only dashboard: GET only" });
    }

    // JSON API
    if (url.pathname.startsWith("/api/")) {
      const name = url.pathname.slice("/api/".length);
      if (name === "health") return json(200, { ok: true });
      if (name === "stream") {
        if (!stream) return json(404, { error: "No live stream" });
        if (req.method === "HEAD") return send(200, "", "text/event-stream");
        if (openStreams >= MAX_STREAMS) {
          return json(503, { error: "Too many open live connections" });
        }
        openStreams++;
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
          ...SECURITY_HEADERS,
        });
        const write = (topic: string, snap: unknown) =>
          res.write(`event: ${topic}\ndata: ${JSON.stringify(snap)}\n\n`);
        res.write("retry: 3000\n\n");
        for (const [topic, snap] of stream.snapshots()) write(topic, snap);
        const unsubscribe = stream.subscribe(write);
        const removeViewer = stream.addViewer?.() || (() => {});
        const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
        req.on("close", () => {
          openStreams--;
          clearInterval(heartbeat);
          unsubscribe();
          removeViewer();
        });
        return;
      }
      const panel = Object.prototype.hasOwnProperty.call(panels, name)
        ? panels[name]
        : undefined;
      if (!panel) return json(404, { error: `Unknown panel: ${name}` });
      try {
        const data = await panel(await context(), url.searchParams);
        return json(200, { data, updated: new Date().toISOString() });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[dashboard] ${name} failed:`, message);
        return json(502, { error: message });
      }
    }

    // Static files, confined to publicDir
    const relative =
      url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    let decoded: string;
    try {
      decoded = decodeURIComponent(relative);
    } catch {
      return send(400, "Bad request", "text/plain; charset=utf-8");
    }
    const filePath = normalize(join(publicDir, decoded));
    if (!filePath.startsWith(normalize(publicDir) + sep)) {
      return send(403, "Forbidden", "text/plain; charset=utf-8");
    }
    try {
      const body = await fs.readFile(filePath);
      const type =
        CONTENT_TYPES[extname(filePath).toLowerCase()] ||
        "application/octet-stream";
      return send(200, body, type, { "Cache-Control": "no-cache" });
    } catch {
      return send(404, "Not found", "text/plain; charset=utf-8");
    }
  });
}

async function main() {
  const { config } = await import("../config.js");
  const { panels, resolveContext, startFeeds } = await import("./data.js");

  if (!config.username) {
    console.error(
      "SLEEPER_USERNAME is not set. Add it to .env (see .env.example) or the environment.",
    );
    process.exit(1);
  }

  const poller = await startFeeds(config.livePollSeconds * 1000, {
    geminiApiKey: config.geminiApiKey,
    geminiModels: config.geminiModels,
  });
  const server = createDashboardServer({
    panels,
    getContext: resolveContext,
    stream: {
      snapshots: () => poller.allSnapshots(),
      subscribe: (listener) => {
        poller.on("update", listener);
        return () => poller.off("update", listener);
      },
      addViewer: () => poller.addViewer(),
    },
  });
  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(
        `Port ${config.dashboardPort} is in use. Set DASHBOARD_PORT to another port.`,
      );
    } else {
      console.error("Dashboard server error:", error.message);
    }
    process.exit(1);
  });
  server.listen(config.dashboardPort, config.dashboardHost, () => {
    const shown =
      config.dashboardHost === "0.0.0.0" ? "localhost" : config.dashboardHost;
    console.error(
      `Sleeper dashboard running at http://${shown}:${config.dashboardPort}`,
    );
    if (config.dashboardHost === "0.0.0.0") {
      console.error(
        "Listening on all network interfaces (reachable from your LAN).",
      );
    }
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
