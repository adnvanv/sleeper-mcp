/**
 * Offline tests for the dashboard's computed views: playoff odds simulation
 * and bye-week lookup.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { simulateSeason, teamByes, userAvatar } from "../dist/dashboard/views.js";

const team = (roster_id, wins, losses, pf = 1000) => ({ roster_id, wins, losses, ties: 0, pf });

test("a clinched team makes the playoffs every time; an eliminated one never does", () => {
  const teams = [team(1, 9, 0), team(2, 5, 4), team(3, 4, 5), team(4, 0, 9)];
  const schedule = new Map([[10, [[1, 2], [3, 4]]]]);
  const projected = new Map(teams.map((t) => [t.roster_id, new Map([[10, 100]])]));
  const r = simulateSeason({ teams, schedule, projected, playoffTeams: 2, byes: 0, medianGame: false, sims: 2000, you: 3, firstWeek: 10 });
  assert.equal(r.playoff_pct.get(1), 100);
  assert.equal(r.playoff_pct.get(4), 0);
  // team 3 needs to win and team 2 to lose: about 25%
  assert.ok(r.playoff_pct.get(3) > 15 && r.playoff_pct.get(3) < 35, `got ${r.playoff_pct.get(3)}`);
  // conditioning on your own game: losing week 10 eliminates team 3
  assert.equal(r.if_lose, 0);
  assert.ok(r.if_win > r.playoff_pct.get(3));
});

test("a much stronger projected team wins more simulated games", () => {
  const teams = [team(1, 4, 4), team(2, 4, 4)];
  const schedule = new Map([[10, [[1, 2]]], [11, [[1, 2]]], [12, [[1, 2]]]]);
  const projected = new Map([
    [1, new Map([[10, 140], [11, 140], [12, 140]])],
    [2, new Map([[10, 90], [11, 90], [12, 90]])],
  ]);
  const r = simulateSeason({ teams, schedule, projected, playoffTeams: 1, byes: 0, medianGame: false, sims: 3000 });
  assert.ok(r.avg_wins.get(1) > 6.5, `got ${r.avg_wins.get(1)}`);
  assert.ok(r.playoff_pct.get(1) > 90);
  // same inputs, same answer (seeded)
  const again = simulateSeason({ teams, schedule, projected, playoffTeams: 1, byes: 0, medianGame: false, sims: 3000 });
  assert.equal(again.playoff_pct.get(1), r.playoff_pct.get(1));
});

test("median games add a win for beating the weekly median", () => {
  const teams = [team(1, 0, 0), team(2, 0, 0), team(3, 0, 0), team(4, 0, 0)];
  const schedule = new Map([[1, [[1, 2], [3, 4]]]]);
  const projected = new Map([
    [1, new Map([[1, 300]])],
    [2, new Map([[1, 10]])],
    [3, new Map([[1, 200]])],
    [4, new Map([[1, 20]])],
  ]);
  const r = simulateSeason({ teams, schedule, projected, playoffTeams: 2, byes: 0, medianGame: true, sims: 500 });
  assert.equal(r.avg_wins.get(1), 2);
  assert.equal(r.avg_wins.get(3), 2);
  assert.equal(r.avg_wins.get(2), 0);
});

test("bye weeks are the weeks a team is missing from the schedule", () => {
  const schedule = [
    { week: 1, home: "A", away: "B" },
    { week: 1, home: "C", away: "D" },
    { week: 2, home: "A", away: "C" },
    { week: 3, home: "B", away: "D" },
  ];
  const byes = teamByes(schedule);
  assert.equal(byes.get("B"), 2);
  assert.equal(byes.get("D"), 2);
  assert.equal(byes.get("A"), 3);
  assert.equal(byes.get("C"), 3);
});

test("team avatars prefer the custom league avatar", () => {
  assert.equal(userAvatar({ avatar: "abc", metadata: { avatar: "https://sleepercdn.com/uploads/x.jpg" } }), "https://sleepercdn.com/uploads/x.jpg");
  assert.equal(userAvatar({ avatar: "abc" }), "https://sleepercdn.com/avatars/thumbs/abc");
  assert.equal(userAvatar(null), null);
});
