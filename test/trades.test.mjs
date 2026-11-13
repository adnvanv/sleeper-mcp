/**
 * Offline tests for trade evaluation and suggestions on a tiny league whose
 * answers can be worked out by hand.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateTrade, lineupPoints, packageValue, positionStrength, suggestTrades } from "../dist/feeds/trades.js";

const pl = (id, position) => [id, { player_id: id, first_name: id, last_name: "", position, fantasy_positions: [position], team: "AAA" }];
// Team 1 (you): two good RBs, a weak WR. Team 2: two good WRs, a weak RB.
const players = new Map([
  pl("r1", "RB"), pl("r2", "RB"), pl("r3", "RB"), pl("w1", "WR"),
  pl("w2", "WR"), pl("w3", "WR"), pl("w4", "WR"), pl("r4", "RB"),
]);
const weekly = { r1: 15, r2: 14, r3: 12, w1: 5, w2: 15, w3: 14, w4: 12, r4: 5 };
const projections = new Map([[10, new Map(Object.entries(weekly))], [11, new Map(Object.entries(weekly))]]);
const values = new Map(Object.entries({ r1: 5000, r2: 4800, r3: 3000, w1: 500, w2: 5000, w3: 4800, w4: 3000, r4: 500 }));
const ctx = { rosterPositions: ["RB", "WR"], fromWeek: 10, throughWeek: 11, playoffStart: 11, projections, players, values };
const me = { roster_id: 1, ids: ["r1", "r2", "r3", "w1"] };
const them = { roster_id: 2, ids: ["w2", "w3", "w4", "r4"] };

test("lineup points sum the best lineup each week, playoffs separately", () => {
  assert.deepEqual(lineupPoints(me.ids, ctx), { ros: 40, playoffs: 20 }); // r1 15 + w1 5, two weeks
});

test("package value discounts the extra players", () => {
  assert.equal(packageValue(["r2"], values), 4800);
  assert.equal(packageValue(["r2", "r3"], values), 4800 + 0.6 * 3000);
});

test("a swap of surplus for need helps both lineups", () => {
  const e = evaluateTrade(ctx, me, them, ["r2"], ["w3"]);
  assert.equal(e.a.ros_gain, 18); // WR slot 5 -> 14, two weeks
  assert.equal(e.b.ros_gain, 18); // RB slot 5 -> 14
  assert.equal(e.value_ratio_b, 1);
  assert.equal(e.acceptance, "likely");
  assert.equal(e.verdict_a, "win");
});

test("a fleece is flagged as a long shot", () => {
  const e = evaluateTrade(ctx, me, them, ["w1"], ["w2"]);
  assert.ok(e.b.ros_gain < 0);
  assert.equal(e.acceptance, "long shot");
});

test("suggestions only include trades both sides gain from at a fair price", () => {
  const strength = new Map([
    [1, new Map([["RB", { group: "RB", ppg: 15, diff: 5, rank: 1 }], ["WR", { group: "WR", ppg: 5, diff: -5, rank: 2 }]])],
    [2, new Map([["RB", { group: "RB", ppg: 5, diff: -5, rank: 2 }], ["WR", { group: "WR", ppg: 15, diff: 5, rank: 1 }]])],
  ]);
  const ideas = suggestTrades(ctx, me, [them], strength, { minGainMe: 3 });
  assert.ok(ideas.length > 0);
  for (const i of ideas) {
    assert.ok(i.a.ros_gain >= 3 && i.b.ros_gain >= 1);
    assert.ok(i.value_ratio_b >= 0.9 && i.value_ratio_b <= 1.35);
    assert.notEqual(i.acceptance, "long shot");
  }
  assert.ok(ideas[0].reasons.some((r) => /Your starting lineup: \+/.test(r)));
});

test("position strength ranks each team's starting slots against the league", () => {
  const weeks = [
    { matchups: [{ roster_id: 1, starters_points: [20, 5] }, { roster_id: 2, starters_points: [10, 15] }] },
    { matchups: [{ roster_id: 1, starters_points: [10, 5] }, { roster_id: 2, starters_points: [10, 15] }] },
  ];
  const s = positionStrength(weeks, ["RB", "WR", "BN"]);
  assert.deepEqual(s.get(1).get("RB"), { group: "RB", ppg: 15, diff: 2.5, rank: 1 });
  assert.deepEqual(s.get(1).get("WR"), { group: "WR", ppg: 5, diff: -5, rank: 2 });
});
