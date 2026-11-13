/**
 * Offline tests for the Gemini article reader: reply parsing, validation,
 * prompt content and model/search fallback (fetch is stubbed).
 */

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { GeminiAnalyst, buildPrompt, parseJsonReply, validRead } from "../dist/feeds/analyst.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const READ = { outlook: "up", confidence: "medium", role: "WR3", health: "Limited (hand)", summary: "Role is growing.", key_points: ["9 targets", "a", "b", "c"] };

test("parses JSON out of a chatty grounded reply", () => {
  assert.deepEqual(parseJsonReply('Here you go:\n```json\n{"a":1}\n```'), { a: 1 });
  assert.throws(() => parseJsonReply("no json here"));
});

test("validates and trims a read", () => {
  const r = validRead({ ...READ, outlook: "sideways", confidence: "huge" });
  assert.equal(r.outlook, "steady");
  assert.equal(r.confidence, "low");
  assert.equal(r.key_points.length, 3);
  assert.throws(() => validRead({ outlook: "up" }));
});

test("prompt carries projection, games, news and the no-new-math rule", () => {
  const p = buildPrompt({
    name: "Tank Dell", position: "WR", team: "HOU", today: "2026-11-13", week: 10, format: "12-team half-PPR redraft",
    injury: "Questionable", projectedPpg: 5.1, weekProjection: 5.14, opponent: "@ CLE",
    games: [{ week: 9, points: 18.5, snap_share: 0.47, targets: 9, carries: 0 }],
    news: [{ published: "2026-11-11T22:00:00Z", source: "Rotowire", title: "Dell (hand) was limited.", summary: "Third receiver." }],
    market: { adds_24h: 133800, drops_24h: 0 },
  });
  for (const bit of ["Tank Dell, WR, HOU, listed Questionable", "5.1 pts a game", "wk9: 18.5 pts, 47% snaps, 9 targets", "2026-11-11 Rotowire: Dell (hand) was limited.", "133800 adds", "don't compute new statistics"]) {
    assert.ok(p.includes(bit), `missing: ${bit}`);
  }
});

function reply(body, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

const okBody = { candidates: [{ content: { parts: [{ text: JSON.stringify(READ) }] } }] };

test("falls back from search to plain JSON mode when search is out of quota", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ model: url.split("/models/")[1].split(":")[0], search: !!body.tools });
    if (body.tools) return reply({ error: { code: 429, message: "quota" } }, 429);
    return reply(okBody);
  };
  const a = new GeminiAnalyst("k", ["m1", "m2"]);
  const out = await a.analyze("prompt");
  assert.equal(out.model, "m1");
  assert.equal(out.searched, false);
  assert.equal(out.read.outlook, "up");
  assert.deepEqual(calls, [{ model: "m1", search: true }, { model: "m1", search: false }]);
  assert.equal(a.searchEnabled, false);
  // next call skips search entirely
  calls.length = 0;
  await a.analyze("prompt");
  assert.deepEqual(calls, [{ model: "m1", search: false }]);
});

test("skips an overloaded or missing model and uses the next", async () => {
  globalThis.fetch = async (url, init) => {
    const model = url.split("/models/")[1].split(":")[0];
    if (JSON.parse(init.body).tools) return reply({ error: { code: 429, message: "no search" } }, 429);
    if (model === "busy") return reply({ error: { code: 503, message: "high demand" } }, 503);
    if (model === "gone") return reply({ error: { code: 404, message: "not found" } }, 404);
    return reply(okBody);
  };
  const out = await new GeminiAnalyst("k", ["busy", "gone", "works"]).analyze("p");
  assert.equal(out.model, "works");
});

test("grounded replies keep their sources", async () => {
  globalThis.fetch = async () =>
    reply({
      candidates: [
        {
          content: { parts: [{ text: `Sure: ${JSON.stringify(READ)}` }] },
          groundingMetadata: { groundingChunks: [{ web: { uri: "https://example.com/a", title: "Beat writer" } }] },
        },
      ],
    });
  const out = await new GeminiAnalyst("k", ["m"]).analyze("p");
  assert.equal(out.searched, true);
  assert.deepEqual(out.sources, [{ title: "Beat writer", url: "https://example.com/a" }]);
});

test("throws when every model fails", async () => {
  globalThis.fetch = async () => reply({ error: { code: 503, message: "down" } }, 503);
  await assert.rejects(new GeminiAnalyst("k", ["a", "b"]).analyze("p"), /down/);
});

test("a model that hangs is skipped on later calls", async () => {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    const model = url.split("/models/")[1].split(":")[0];
    seen.push(model);
    if (JSON.parse(init.body).tools) return reply({ error: { code: 429, message: "no search" } }, 429);
    if (model === "slow") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    return reply(okBody);
  };
  const a = new GeminiAnalyst("k", ["slow", "ok"]);
  assert.equal((await a.analyze("p")).model, "ok");
  seen.length = 0;
  await a.analyze("p");
  assert.deepEqual(seen, ["ok"]);
});
