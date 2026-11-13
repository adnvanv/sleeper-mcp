/**
 * Offline tests for the dashboard server and refresh schedule.
 * The server runs with fake panels, so no network is needed.
 */

import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { createDashboardServer } from "../dist/dashboard/server.js";
import { panels } from "../dist/dashboard/data.js";
import {
  isGameWindow,
  refreshInterval,
  LIVE_INTERVAL_MS,
  IDLE_INTERVAL_MS,
} from "../dashboard/public/refresh.js";

let server;
let base;
let contextCalls = 0;

before(async () => {
  server = createDashboardServer({
    getContext: async () => {
      contextCalls++;
      return { leagueId: "L", userId: "U" };
    },
    panels: {
      standings: async (ctx) => ({ league: ctx.leagueId, rows: [1, 2] }),
      broken: async () => {
        throw new Error("Sleeper is down");
      },
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test("serves the dashboard page with security headers", async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.match(
    res.headers.get("content-security-policy"),
    /default-src 'self'/,
  );
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.match(await res.text(), /<nav class="tabs"/);
});

test("serves static assets with the right type", async () => {
  const js = await fetch(`${base}/app.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type"), /javascript/);
  const css = await fetch(`${base}/styles.css`);
  assert.match(css.headers.get("content-type"), /text\/css/);
});

test("API returns panel data with a timestamp", async () => {
  const res = await fetch(`${base}/api/standings`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.json();
  assert.deepEqual(body.data, { league: "L", rows: [1, 2] });
  assert.ok(!Number.isNaN(Date.parse(body.updated)));
});

test("context is resolved once and reused", async () => {
  await fetch(`${base}/api/standings`);
  await fetch(`${base}/api/standings`);
  assert.equal(contextCalls, 1);
});

test("panel errors become a 502 with the message", async () => {
  const res = await fetch(`${base}/api/broken`);
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "Sleeper is down" });
});

test("unknown panels and prototype keys are 404", async () => {
  assert.equal((await fetch(`${base}/api/nope`)).status, 404);
  assert.equal((await fetch(`${base}/api/constructor`)).status, 404);
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
});

test("path traversal is blocked", async () => {
  for (const path of ["/..%2f..%2fpackage.json", "/%2e%2e/%2e%2e/.env"]) {
    const res = await fetch(`${base}${path}`);
    assert.ok([403, 404].includes(res.status), `${path} -> ${res.status}`);
    assert.doesNotMatch(await res.text(), /SLEEPER_|"name"/);
  }
  assert.equal((await fetch(`${base}/%E0%A4%A`)).status, 400);
});

test("read-only: non-GET methods are rejected", async () => {
  const res = await fetch(`${base}/api/standings`, { method: "POST" });
  assert.equal(res.status, 405);
});

test("real dashboard exposes the expected panels", () => {
  assert.deepEqual(Object.keys(panels).sort(), [
    "activity",
    "advice",
    "feeds",
    "free-agents",
    "live",
    "matchups",
    "news",
    "outlook",
    "roster",
    "standings",
    "summary",
    "transactions",
    "usage",
    "values",
  ]);
});

// Eastern time is UTC-5 in November/December/January, UTC-4 in September.
const et = (iso) => new Date(iso);

test("game windows: Sunday afternoon, MNF, TNF are live", () => {
  assert.equal(isGameWindow(et("2026-11-15T18:00:00Z")), true); // Sun 1pm ET
  assert.equal(isGameWindow(et("2026-11-15T14:30:00Z")), true); // Sun 9:30am London
  assert.equal(isGameWindow(et("2026-11-17T02:00:00Z")), true); // Mon 9pm ET
  assert.equal(isGameWindow(et("2026-11-13T01:30:00Z")), true); // Thu 8:30pm ET
  assert.equal(isGameWindow(et("2026-11-17T05:30:00Z")), true); // Tue 12:30am ET
});

test("game windows: weekdays and mornings are idle", () => {
  assert.equal(isGameWindow(et("2026-11-18T17:00:00Z")), false); // Wed noon ET
  assert.equal(isGameWindow(et("2026-11-15T12:00:00Z")), false); // Sun 7am ET
  assert.equal(isGameWindow(et("2026-11-16T17:00:00Z")), false); // Mon noon ET
  assert.equal(isGameWindow(et("2026-11-14T20:00:00Z")), false); // Sat in Nov
});

test("game windows: December Saturdays are live", () => {
  assert.equal(isGameWindow(et("2026-12-19T21:00:00Z")), true); // Sat 4pm ET
});

test("refresh interval follows the game window", () => {
  assert.equal(refreshInterval(et("2026-11-15T18:00:00Z")), LIVE_INTERVAL_MS);
  assert.equal(refreshInterval(et("2026-11-18T17:00:00Z")), IDLE_INTERVAL_MS);
});

test("live stream sends current snapshots, then updates, and counts viewers", async () => {
  const listeners = new Set();
  let viewers = 0;
  const streamServer = createDashboardServer({
    getContext: async () => ({}),
    panels: {},
    stream: {
      snapshots: () => [["live", { data: { week: 10 }, updated: "t0" }]],
      subscribe: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      addViewer: () => {
        viewers++;
        return () => viewers--;
      },
    },
  });
  await new Promise((resolve) => streamServer.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${streamServer.address().port}/api/stream`;
  const controller = new AbortController();
  try {
    const res = await fetch(url, { signal: controller.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/event-stream/);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const readUntil = async (pattern) => {
      while (!pattern.test(text)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
    };
    await readUntil(/event: live\ndata: .*\n\n/);
    assert.match(text, /data: \{"data":\{"week":10\},"updated":"t0"\}/);
    assert.equal(viewers, 1);
    for (const fn of listeners) fn("news", { data: { items: [] }, updated: "t1" });
    await readUntil(/event: news/);
    assert.match(text, /event: news\ndata: \{"data":\{"items":\[\]\},"updated":"t1"\}/);
    controller.abort();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(viewers, 0);
    assert.equal(listeners.size, 0);
  } finally {
    controller.abort();
    streamServer.close();
  }
});

test("stream route is a 404 when no stream is configured", async () => {
  const res = await fetch(`${base}/api/stream`);
  assert.equal(res.status, 404);
});
