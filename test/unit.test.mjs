/**
 * Offline unit tests (no network). Run after `npm run build`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEnvFile, loadConfig } from "../dist/config.js";
import { DefaultsResolver } from "../dist/defaults.js";

function fakeClient({ leagues = [], userId = "111" } = {}) {
  const calls = { getUser: 0, getUserLeagues: 0 };
  return {
    calls,
    async getUser(name) {
      calls.getUser++;
      return name === "missing" ? null : { user_id: userId, username: name };
    },
    async getUserLeagues() {
      calls.getUserLeagues++;
      return leagues;
    },
    async getNFLState() {
      return { season: "2026", week: 10 };
    },
  };
}

test("parseEnvFile handles comments, blanks and quotes", () => {
  const parsed = parseEnvFile(
    '# comment\n\nSLEEPER_USERNAME="someone"\r\nSLEEPER_LEAGUE_ID=123\nBAD\n',
  );
  assert.deepEqual(parsed, {
    SLEEPER_USERNAME: "someone",
    SLEEPER_LEAGUE_ID: "123",
  });
});

test("loadConfig prefers real env vars over .env values", () => {
  const cfg = loadConfig(
    { SLEEPER_USERNAME: "fromenv" },
    { SLEEPER_USERNAME: "fromfile", SLEEPER_LEAGUE_ID: "42" },
  );
  assert.equal(cfg.username, "fromenv");
  assert.equal(cfg.leagueId, "42");
});

test("loadConfig treats empty values as unset", () => {
  const cfg = loadConfig({ SLEEPER_LEAGUE_ID: " " }, {});
  assert.equal(cfg.username, undefined);
  assert.equal(cfg.leagueId, undefined);
});

test("dashboard host and port default and validate", () => {
  assert.deepEqual(
    [loadConfig({}, {}).dashboardHost, loadConfig({}, {}).dashboardPort],
    ["127.0.0.1", 3030],
  );
  const cfg = loadConfig({ DASHBOARD_HOST: "0.0.0.0" }, { DASHBOARD_PORT: "8080" });
  assert.deepEqual([cfg.dashboardHost, cfg.dashboardPort], ["0.0.0.0", 8080]);
  assert.equal(loadConfig({ DASHBOARD_PORT: "nope" }, {}).dashboardPort, 3030);
  assert.equal(loadConfig({ DASHBOARD_PORT: "70000" }, {}).dashboardPort, 3030);
});

test("fills username for get_user_info", async () => {
  const r = new DefaultsResolver(fakeClient(), { username: "me" });
  assert.deepEqual(await r.apply("get_user_info", {}), {
    username_or_id: "me",
  });
});

test("explicit arguments are left alone", async () => {
  const client = fakeClient();
  const r = new DefaultsResolver(client, { username: "me", leagueId: "9" });
  const out = await r.apply("analyze_lineup", {
    league_id: "5",
    user_id: "777",
  });
  assert.deepEqual(out, { league_id: "5", user_id: "777" });
  assert.equal(client.calls.getUser, 0);
});

test("resolves username to user_id and caches it", async () => {
  const client = fakeClient({ userId: "555" });
  const r = new DefaultsResolver(client, { username: "me", leagueId: "9" });
  const out = await r.apply("get_start_sit_advice", {});
  assert.deepEqual(out, { user_id: "555", league_id: "9" });
  await r.apply("get_start_sit_advice", { user_id: "ME" });
  assert.equal(client.calls.getUser, 1);
});

test("fills current season for get_user_leagues", async () => {
  const r = new DefaultsResolver(fakeClient(), { username: "me" });
  const out = await r.apply("get_user_leagues", {});
  assert.equal(out.season, "2026");
  assert.equal(out.user_id, "111");
});

test("uses the only league when SLEEPER_LEAGUE_ID is unset", async () => {
  const client = fakeClient({ leagues: [{ league_id: "L1", name: "One" }] });
  const r = new DefaultsResolver(client, { username: "me" });
  assert.equal((await r.apply("get_league_info", {})).league_id, "L1");
});

test("errors when several leagues and no default", async () => {
  const client = fakeClient({
    leagues: [
      { league_id: "L1", name: "One" },
      { league_id: "L2", name: "Two" },
    ],
  });
  const r = new DefaultsResolver(client, { username: "me" });
  await assert.rejects(r.apply("get_league_info", {}), /Multiple leagues.*L2/);
});

test("errors clearly when no username is configured", async () => {
  const r = new DefaultsResolver(fakeClient(), {});
  await assert.rejects(r.apply("get_user_info", {}), /SLEEPER_USERNAME/);
});

test("errors when username lookup finds nobody", async () => {
  const r = new DefaultsResolver(fakeClient(), { username: "missing" });
  await assert.rejects(r.apply("analyze_lineup", {}), /not found/);
});

test("tools without league/user params are untouched", async () => {
  const client = fakeClient();
  const r = new DefaultsResolver(client, {});
  assert.deepEqual(await r.apply("search_players", { query: "x" }), {
    query: "x",
  });
});
