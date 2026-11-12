/**
 * Offline tests for get_trending_free_agents logic. Run after `npm run build`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findTrendingFreeAgents,
  getRosteredPlayerIds,
  getLeaguePositions,
} from "../dist/free-agents.js";

const player = (id, position, extra = {}) => [
  id,
  {
    player_id: id,
    first_name: "P",
    last_name: id,
    position,
    fantasy_positions: [position],
    team: "KC",
    ...extra,
  },
];

const players = new Map([
  player("1", "WR"),
  player("2", "RB"),
  player("3", "WR", { injury_status: "Questionable" }),
  player("4", "K"),
  player("5", "LB"),
  player("6", "TE"),
  player("7", "QB"),
]);

const rosters = [
  { roster_id: 1, owner_id: "a", players: ["1"], starters: [] },
  { roster_id: 2, owner_id: "b", players: [], reserve: ["2"], taxi: null },
  { roster_id: 3, owner_id: "c", players: null, taxi: ["6"] },
];

const trending = [
  { player_id: "3", count: 500 },
  { player_id: "1", count: 900 },
  { player_id: "2", count: 800 },
  { player_id: "4", count: 300 },
  { player_id: "5", count: 200 },
  { player_id: "6", count: 150 },
  { player_id: "7", count: 100 },
  { player_id: "999", count: 50 }, // unknown player id
];

const standardSlots = [
  "QB",
  "RB",
  "RB",
  "WR",
  "WR",
  "TE",
  "FLEX",
  "K",
  "DEF",
  "BN",
  "BN",
  "IR",
];

test("getRosteredPlayerIds includes players, IR and taxi, tolerating nulls", () => {
  assert.deepEqual([...getRosteredPlayerIds(rosters)].sort(), ["1", "2", "6"]);
});

test("getLeaguePositions expands flex slots and ignores bench/IR", () => {
  const positions = getLeaguePositions(["SUPER_FLEX", "BN", "IR"]);
  assert.deepEqual([...positions].sort(), ["QB", "RB", "TE", "WR"]);
  assert.equal(getLeaguePositions([]), null);
  assert.equal(getLeaguePositions(undefined), null);
});

test("excludes rostered players and sorts by add count", () => {
  const { free_agents, rostered_skipped } = findTrendingFreeAgents(
    trending,
    rosters,
    players,
    { rosterPositions: standardSlots },
  );
  assert.deepEqual(
    free_agents.map((p) => p.player_id),
    ["3", "4", "7"],
  );
  assert.equal(rostered_skipped, 3);
  assert.equal(free_agents[0].trending_adds, 500);
  assert.equal(free_agents[0].injury_status, "Questionable");
  assert.equal(free_agents[0].trend_rank, 3);
});

test("drops positions the league doesn't start (LB in a non-IDP league)", () => {
  const { free_agents } = findTrendingFreeAgents(trending, rosters, players, {
    rosterPositions: standardSlots,
  });
  assert.ok(!free_agents.some((p) => p.position === "LB"));
});

test("keeps every position when the league has no slot info", () => {
  const { free_agents } = findTrendingFreeAgents(trending, rosters, players);
  assert.ok(free_agents.some((p) => p.position === "LB"));
});

test("position filter is case-insensitive", () => {
  const { free_agents } = findTrendingFreeAgents(trending, rosters, players, {
    position: "wr",
    rosterPositions: standardSlots,
  });
  assert.deepEqual(
    free_agents.map((p) => p.player_id),
    ["3"],
  );
});

test("limit caps the result count", () => {
  const { free_agents } = findTrendingFreeAgents(trending, [], players, {
    limit: 2,
  });
  assert.equal(free_agents.length, 2);
  assert.deepEqual(
    free_agents.map((p) => p.player_id),
    ["1", "2"],
  );
});
