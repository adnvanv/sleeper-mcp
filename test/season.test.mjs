/**
 * Offline tests for shared season helpers. Run after `npm run build`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  byeTeams,
  nflOpponent,
  optimalLineup,
  playerStats,
  rosterPlayerIds,
  startingSlots,
} from "../dist/season.js";

const schedule = [
  { week: 1, home: "KC", away: "BUF" },
  { week: 1, home: "DAL", away: "NYG" },
  { week: 2, home: "BUF", away: "DAL" },
];

test("byeTeams finds teams with no game that week", () => {
  assert.deepEqual([...byeTeams(schedule, 2)].sort(), ["KC", "NYG"]);
  assert.equal(byeTeams(schedule, 1).size, 0);
  assert.equal(byeTeams(schedule, 9).size, 0); // unknown week: no info
  assert.equal(byeTeams([], 1).size, 0);
});

test("nflOpponent shows home/away", () => {
  assert.equal(nflOpponent(schedule, 1, "KC"), "vs BUF");
  assert.equal(nflOpponent(schedule, 1, "BUF"), "@ KC");
  assert.equal(nflOpponent(schedule, 2, "KC"), null);
  assert.equal(nflOpponent(schedule, 1, null), null);
});

test("startingSlots drops bench, IR and taxi", () => {
  assert.deepEqual(startingSlots(["QB", "FLEX", "BN", "IR", "TAXI"]), [
    "QB",
    "FLEX",
  ]);
});

test("playerStats skips zero weeks for ppg", () => {
  const weeks = [
    { week: 1, matchups: [{ points: 50, players_points: { a: 10, b: 0 } }] },
    { week: 2, matchups: [{ points: 50, players_points: { a: 20, b: 6 } }] },
    { week: 3, matchups: [{ points: 0, players_points: { a: 0 } }] }, // unplayed
  ];
  const s = playerStats(weeks);
  assert.deepEqual(s.get("a"), { total: 30, games: 2, ppg: 15 });
  assert.deepEqual(s.get("b"), { total: 6, games: 1, ppg: 6 });
});

test("optimalLineup fills restrictive slots before flex", () => {
  const pos = { q: ["QB"], r1: ["RB"], r2: ["RB"], w: ["WR"], t: ["TE"] };
  const val = { q: 20, r1: 15, r2: 12, w: 14, t: 5 };
  const lineup = optimalLineup(
    Object.keys(pos),
    ["QB", "FLEX", "RB", "WR", "BN"],
    (id) => val[id],
    (id) => pos[id],
  );
  // RB slot takes r1, WR takes w, FLEX gets best leftover (r2 over t)
  assert.deepEqual(
    lineup.starters.map((s) => [s.slot, s.player_id]),
    [
      ["QB", "q"],
      ["FLEX", "r2"],
      ["RB", "r1"],
      ["WR", "w"],
    ],
  );
  assert.equal(lineup.total, 61);
  assert.deepEqual(lineup.bench, ["t"]);
});

test("optimalLineup leaves a slot empty when nobody fits", () => {
  const lineup = optimalLineup(
    ["q"],
    ["QB", "TE"],
    () => 10,
    () => ["QB"],
  );
  assert.equal(lineup.starters[1].player_id, null);
  assert.equal(lineup.total, 10);
});

test("rosterPlayerIds merges players, IR and taxi without duplicates", () => {
  assert.deepEqual(
    rosterPlayerIds({ players: ["a", "b"], reserve: ["b"], taxi: ["c"] }),
    ["a", "b", "c"],
  );
});
