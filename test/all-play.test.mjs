/**
 * Offline tests for get_all_play_records logic. Run after `npm run build`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeAllPlay,
  playedWeeks,
  resolveThroughWeek,
} from "../dist/all-play.js";

const rosters = [1, 2, 3, 4].map((id) => ({
  roster_id: id,
  owner_id: `u${id}`,
  players: [],
  starters: [],
}));

const users = [
  { user_id: "u1", display_name: "Ann", metadata: { team_name: "Aces" } },
  { user_id: "u2", display_name: "Bo" },
  { user_id: "u3", display_name: "Cy" },
  // u4 has left the league: falls back to "Team 4"
];

const m = (roster_id, matchup_id, points) => ({
  roster_id,
  matchup_id,
  points,
  starters: [],
  players: [],
});

// Week 1: 1 beats 2 (120-110), 3 beats 4 (90-80). Team 2 is unlucky:
// second-best score but lost.
// Week 2: 1 beats 3 (100-95), 4 beats 2 (70-60).
// Week 3: unplayed (all zeros), must be ignored.
const weeks = [
  { week: 1, matchups: [m(1, 1, 120), m(2, 1, 110), m(3, 2, 90), m(4, 2, 80)] },
  { week: 2, matchups: [m(1, 1, 100), m(3, 1, 95), m(2, 2, 60), m(4, 2, 70)] },
  { week: 3, matchups: [m(1, 1, 0), m(2, 1, 0), m(3, 2, 0), m(4, 2, 0)] },
];

const byId = (records) => new Map(records.map((r) => [r.roster_id, r]));

test("playedWeeks drops weeks where nobody scored", () => {
  assert.deepEqual(
    playedWeeks(weeks).map((w) => w.week),
    [1, 2],
  );
});

test("all-play records compare every team every week", () => {
  const r = byId(computeAllPlay(weeks, rosters, users));
  // Team 1 top both weeks: 3-0 twice
  assert.deepEqual(r.get(1).all_play, {
    wins: 6,
    losses: 0,
    ties: 0,
    win_pct: 1,
  });
  // Team 2: wk1 beats 3,4 (2-1); wk2 lowest (0-3)
  assert.deepEqual([r.get(2).all_play.wins, r.get(2).all_play.losses], [2, 4]);
  // Team 3: wk1 beats 4 (1-2); wk2 second (2-1)
  assert.deepEqual([r.get(3).all_play.wins, r.get(3).all_play.losses], [3, 3]);
  // Team 4: wk1 lowest (0-3); wk2 beats 2 (1-2)
  assert.deepEqual([r.get(4).all_play.wins, r.get(4).all_play.losses], [1, 5]);
});

test("actual records come from head-to-head matchups", () => {
  const r = byId(computeAllPlay(weeks, rosters, users));
  assert.deepEqual(
    [1, 2, 3, 4].map((id) => [r.get(id).actual.wins, r.get(id).actual.losses]),
    [
      [2, 0],
      [0, 2],
      [1, 1],
      [1, 1],
    ],
  );
});

test("expected wins and luck", () => {
  const r = byId(computeAllPlay(weeks, rosters, users));
  // Team 2 expected 2/3 + 0 = 0.67, won 0 -> luck -0.67 (unlucky)
  assert.equal(r.get(2).expected_wins, 0.67);
  assert.equal(r.get(2).luck, -0.67);
  // Team 4 expected 0 + 1/3 = 0.33, won 1 -> luck +0.67 (lucky)
  assert.equal(r.get(4).luck, 0.67);
  // Luck sums to ~0 across the league
  const total = [...r.values()].reduce((s, x) => s + x.luck, 0);
  assert.ok(Math.abs(total) < 0.02);
});

test("ranks, names, points and high scores", () => {
  const records = computeAllPlay(weeks, rosters, users);
  assert.deepEqual(
    records.map((x) => x.roster_id),
    [1, 3, 2, 4],
  );
  const r = byId(records);
  assert.equal(r.get(1).team_name, "Aces");
  assert.equal(r.get(1).owner_id, "u1");
  assert.equal(r.get(2).team_name, "Bo");
  assert.equal(r.get(4).team_name, "Team 4");
  assert.equal(r.get(1).points_for, 220);
  assert.equal(r.get(1).weekly_high_scores, 2);
  // Actual: 1 (2-0), then 3 and 4 at 1-1 split by points (185 vs 150), then 2
  assert.deepEqual(
    [1, 3, 4, 2].map((id) => r.get(id).actual_rank),
    [1, 2, 3, 4],
  );
});

test("ties count as half in all-play and actual records", () => {
  const tied = [{ week: 1, matchups: [m(1, 1, 100), m(2, 1, 100)] }];
  const r = byId(computeAllPlay(tied, rosters.slice(0, 2), users));
  assert.deepEqual(r.get(1).all_play, {
    wins: 0,
    losses: 0,
    ties: 1,
    win_pct: 0.5,
  });
  assert.equal(r.get(1).actual.ties, 1);
  assert.equal(r.get(1).luck, 0);
});

test("median game adds a win or loss vs the weekly median, not luck", () => {
  const r = byId(computeAllPlay(weeks, rosters, users, { medianGame: true }));
  // Week 1 median 100: 1,2 above; week 2 median 82.5: 1,3 above
  assert.deepEqual([r.get(1).actual.wins, r.get(1).actual.losses], [4, 0]);
  assert.deepEqual([r.get(2).actual.wins, r.get(2).actual.losses], [1, 3]);
  // Luck unchanged by the median game
  assert.equal(r.get(2).luck, -0.67);
});

test("resolveThroughWeek picks a sensible last week", () => {
  // Uses last scored week by default
  assert.equal(
    resolveThroughWeek({
      lastScoredWeek: 9,
      currentWeek: 10,
      playoffWeekStart: 15,
    }),
    9,
  );
  // Falls back to current week - 1
  assert.equal(resolveThroughWeek({ currentWeek: 10 }), 9);
  // Never counts playoff weeks
  assert.equal(
    resolveThroughWeek({
      lastScoredWeek: 16,
      currentWeek: 17,
      playoffWeekStart: 15,
    }),
    14,
  );
  // Explicit request wins, but is still capped
  assert.equal(
    resolveThroughWeek({ requested: 5, lastScoredWeek: 9, currentWeek: 10 }),
    5,
  );
  assert.equal(resolveThroughWeek({ currentWeek: 1 }), 0);
});
