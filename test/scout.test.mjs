/**
 * Offline tests for get_opponent_scout logic. Run after `npm run build`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { scoutOpponent, slotAverages } from "../dist/scout.js";

const players = new Map(
  [
    ["q1", "QB", "KC"],
    ["q2", "QB", "BUF", "Out"],
    ["r1", "RB", "DAL"],
    ["r2", "RB", "NYG"],
    ["w1", "WR", "KC"],
    ["w2", "WR", "DAL"],
  ].map(([id, position, team, injury_status]) => [
    id,
    { first_name: "P", last_name: id, position, team, injury_status },
  ]),
);

const rosterPositions = ["QB", "RB", "WR", "BN", "BN"];
const rosters = [
  {
    roster_id: 1,
    owner_id: "me",
    players: ["q1", "r1", "w1"],
    settings: { wins: 5, losses: 4, ties: 0, fpts: 900, fpts_decimal: 50 },
  },
  {
    roster_id: 2,
    owner_id: "opp",
    players: ["q2", "r2", "w2"],
    settings: { wins: 3, losses: 6, ties: 0, fpts: 800, fpts_decimal: 0 },
  },
];
const users = [
  { user_id: "me", display_name: "Me" },
  { user_id: "opp", display_name: "Opp", metadata: { team_name: "Rivals" } },
];

// Week 2: KC is on bye
const schedule = [
  { week: 1, home: "KC", away: "BUF" },
  { week: 1, home: "DAL", away: "NYG" },
  { week: 2, home: "BUF", away: "DAL" },
  { week: 2, home: "NYG", away: "MIA" },
];

const weeks = [
  {
    week: 1,
    matchups: [
      {
        roster_id: 1,
        matchup_id: 1,
        points: 60,
        starters_points: [20, 20, 20],
        players_points: { q1: 20, r1: 20, w1: 20 },
      },
      {
        roster_id: 2,
        matchup_id: 1,
        points: 40,
        starters_points: [10, 25, 5],
        players_points: { q2: 10, r2: 25, w2: 5 },
      },
    ],
  },
];

const currentMatchups = [
  {
    roster_id: 1,
    matchup_id: 3,
    points: 12.5,
    starters: ["q1", "r1", "w1"],
    starters_points: [12.5, 0, 0],
  },
  {
    roster_id: 2,
    matchup_id: 3,
    points: 7,
    starters: ["q2", "r2", "0"], // empty WR slot
    starters_points: [0, 7, 0],
    players: ["q2", "r2", "w2"],
  },
];

const transactions = [
  {
    transaction_id: "t1",
    status: "complete",
    type: "waiver",
    roster_ids: [2],
    adds: { w2: 2 },
    drops: {},
    settings: { waiver_bid: 7 },
    leg: 2,
    created: Date.UTC(2026, 8, 20),
  },
  {
    transaction_id: "t2",
    status: "failed",
    type: "waiver",
    roster_ids: [2],
    adds: { x: 2 },
    leg: 2,
    created: Date.UTC(2026, 8, 21),
  },
  {
    transaction_id: "t3",
    status: "complete",
    type: "free_agent",
    roster_ids: [1],
    adds: { y: 1 },
    leg: 2,
    created: Date.UTC(2026, 8, 22),
  },
];

const base = {
  myRosterId: 1,
  week: 2,
  currentMatchups,
  weeks,
  rosters,
  users,
  players,
  rosterPositions,
  schedule,
  transactions,
};

test("finds the opponent and current score", () => {
  const r = scoutOpponent(base);
  assert.equal(r.has_opponent, true);
  assert.equal(r.opponent.team_name, "Rivals");
  assert.equal(r.opponent.record, "3-6");
  assert.deepEqual(r.score, { you: 12.5, them: 7 });
});

test("flags injured, empty and bye starters", () => {
  const r = scoutOpponent(base);
  const [qb, rb, wr] = r.their_lineup;
  assert.deepEqual(qb.flags, ["OUT"]);
  assert.equal(qb.nfl_opponent, "vs DAL");
  assert.equal(rb.points_this_week, 7);
  assert.equal(rb.season_ppg, 25);
  assert.deepEqual(wr.flags, ["EMPTY SLOT"]);
  assert.equal(r.lineup_problems.length, 2);

  // Same lineup but their RB plays for KC (on bye in week 2)
  const byePlayers = new Map(players);
  byePlayers.set("r2", { ...players.get("r2"), team: "KC" });
  const r2 = scoutOpponent({ ...base, players: byePlayers });
  assert.ok(r2.their_lineup[1].flags.includes("ON BYE"));
  assert.equal(r2.their_lineup[1].on_bye, true);
});

test("weak spots and strengths compare slot averages to the league", () => {
  const r = scoutOpponent(base);
  // League avg QB 15 (20,10): they're -5. WR avg 12.5: they're -7.5
  assert.deepEqual(
    r.weak_spots.map((w) => [w.slot, w.diff]),
    [
      ["WR", -7.5],
      ["QB", -5],
    ],
  );
  assert.deepEqual(
    r.strengths.map((w) => [w.slot, w.diff]),
    [["RB", 2.5]],
  );
});

test("bench and recent moves only cover the opponent", () => {
  const r = scoutOpponent(base);
  assert.deepEqual(
    r.bench.map((b) => b.player_id),
    ["w2"],
  );
  assert.equal(r.recent_moves.length, 1); // failed claim and my move excluded
  assert.deepEqual(r.recent_moves[0].added, ["P w2"]);
  assert.equal(r.recent_moves[0].faab_bid, 7);
});

test("no opponent on a bye or unset week", () => {
  assert.equal(
    scoutOpponent({ ...base, currentMatchups: [] }).has_opponent,
    false,
  );
  const solo = [{ ...currentMatchups[0], matchup_id: null }];
  assert.equal(
    scoutOpponent({ ...base, currentMatchups: solo }).has_opponent,
    false,
  );
});

test("slotAverages averages starters_points per slot", () => {
  const { byRoster, league } = slotAverages(weeks, 3);
  assert.deepEqual(byRoster.get(2), [10, 25, 5]);
  assert.deepEqual(league, [15, 22.5, 12.5]);
});
