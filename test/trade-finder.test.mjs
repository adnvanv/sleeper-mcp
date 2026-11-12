/**
 * Offline tests for find_trade_partners logic. Run after `npm run build`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findTrades,
  playerValue,
  positionReports,
  replacementLevels,
} from "../dist/trade-finder.js";

// Tiny league: lineup is 1 RB + 1 WR. I have two good RBs and a weak WR;
// team 2 has two good WRs and a weak RB. Team 3 has nothing I want.
const P = (position) => ({ first_name: "", last_name: "", position });
const players = new Map([
  ["myRB1", { ...P("RB"), last_name: "MyRB1" }],
  ["myRB2", { ...P("RB"), last_name: "MyRB2" }],
  ["myWR", { ...P("WR"), last_name: "MyWR" }],
  ["thRB", { ...P("RB"), last_name: "TheirRB" }],
  ["thWR1", { ...P("WR"), last_name: "TheirWR1" }],
  ["thWR2", { ...P("WR"), last_name: "TheirWR2" }],
  ["t3RB", { ...P("RB"), last_name: "T3RB" }],
  ["t3WR", { ...P("WR"), last_name: "T3WR" }],
  ["star", { ...P("WR"), last_name: "Star" }],
]);
const stat = (ppg, games = 5) => ({ total: ppg * games, games, ppg });
const stats = new Map([
  ["myRB1", stat(16)],
  ["myRB2", stat(14)],
  ["myWR", stat(6)],
  ["thRB", stat(5)],
  ["thWR1", stat(15)],
  ["thWR2", stat(13)],
  ["t3RB", stat(9)],
  ["t3WR", stat(9)],
  ["star", stat(30)],
]);
const rosters = [
  { roster_id: 1, owner_id: "me", players: ["myRB1", "myRB2", "myWR"] },
  { roster_id: 2, owner_id: "u2", players: ["thRB", "thWR1", "thWR2"] },
  { roster_id: 3, owner_id: "u3", players: ["t3RB", "t3WR"] },
];
const users = [
  { user_id: "me", display_name: "Me" },
  { user_id: "u2", display_name: "Two" },
  { user_id: "u3", display_name: "Three" },
];
const base = {
  myRosterId: 1,
  rosters,
  users,
  players,
  stats,
  rosterPositions: ["RB", "WR", "BN", "BN"],
};

test("playerValue shrinks tiny samples", () => {
  assert.equal(playerValue(stat(12, 1)), 4);
  assert.equal(playerValue(stat(12, 3)), 12);
  assert.equal(playerValue(undefined), 0);
});

test("finds the RB-for-WR swap that helps both teams", () => {
  const ideas = findTrades(base);
  assert.ok(ideas.length > 0);
  const top = ideas[0];
  assert.equal(top.partner, "Two");
  assert.equal(top.you_give.position, "RB");
  assert.equal(top.you_get.position, "WR");
  assert.ok(top.your_lineup_gain > 0);
  assert.ok(top.their_lineup_gain > 0);
  // Every idea must help both sides
  assert.ok(
    ideas.every((i) => i.your_lineup_gain > 0 && i.their_lineup_gain > 0),
  );
});

test("never suggests fleecing: star for a backup is filtered out", () => {
  const withStar = {
    ...base,
    rosters: [
      rosters[0],
      { ...rosters[1], players: ["thRB", "thWR1", "thWR2", "star"] },
      rosters[2],
    ],
  };
  const ideas = findTrades(withStar);
  assert.ok(!ideas.some((i) => i.you_get.player_id === "star"));
});

test("target_position limits what you receive", () => {
  assert.equal(findTrades({ ...base, targetPosition: "rb" }).length, 0);
  assert.ok(
    findTrades({ ...base, targetPosition: "WR" }).every(
      (i) => i.you_get.position === "WR",
    ),
  );
});

test("at most two ideas per partner, and limit applies", () => {
  const ideas = findTrades({ ...base, limit: 1 });
  assert.equal(ideas.length, 1);
  const all = findTrades(base);
  const perPartner = all.reduce(
    (m, i) => m.set(i.partner, (m.get(i.partner) || 0) + 1),
    new Map(),
  );
  assert.ok([...perPartner.values()].every((n) => n <= 2));
});

test("positionReports marks my RB strength, WR need and RB surplus", () => {
  const reports = positionReports(base);
  const rb = reports.find((r) => r.position === "RB");
  const wr = reports.find((r) => r.position === "WR");
  assert.equal(rb.verdict, "strength");
  assert.equal(rb.rank, 1);
  assert.equal(wr.verdict, "need");
  assert.deepEqual(
    rb.surplus.map((s) => s.name),
    ["MyRB2"],
  );
});

test("replacementLevels uses the first non-starter at each position", () => {
  const levels = replacementLevels(
    rosters,
    ["RB", "WR"],
    (id) => playerValue(stats.get(id)),
    (id) => [players.get(id).position],
  );
  // 3 teams x 1 RB slot -> 4th best RB (5 ppg)
  assert.equal(levels.get("RB"), 5);
  // 3 teams x 1 WR slot -> 4th best WR (6 ppg)
  assert.equal(levels.get("WR"), 6);
});

test("unknown roster returns nothing", () => {
  assert.deepEqual(findTrades({ ...base, myRosterId: 99 }), []);
});
