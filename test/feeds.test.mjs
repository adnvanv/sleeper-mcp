/**
 * Offline tests for the dashboard's outside data feeds: RSS and news parsing,
 * player matching, live scoring, usage trends, schedule strength, trade values.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRss, parseRssDate, decodeEntities } from "../dist/feeds/rss.js";
import {
  buildPlayerIndex,
  classifyNews,
  mergeNews,
  normalizeName,
  parseEspnNews,
  parseRotowireNews,
  tagNews,
} from "../dist/feeds/news.js";
import {
  fractionLeft,
  liveSide,
  gamesByTeam,
  parseScoreboard,
  scoreEvents,
  statLine,
  winProbability,
  anyPlaying,
} from "../dist/feeds/live.js";
import {
  fantasyCalcParams,
  leaguePoints,
  pointsAllowed,
  projectionMap,
  riserScore,
  scheduleOutlook,
  tradeValues,
  usageTrends,
} from "../dist/feeds/analysis.js";

const player = (id, first, last, position, team, extra = {}) => [
  id,
  { player_id: id, first_name: first, last_name: last, position, team, ...extra },
];

const players = new Map([
  player("1", "Puka", "Nacua", "WR", "LAR", { rotowire_id: 16790, espn_id: 4426515 }),
  player("2", "Kenneth", "Walker III", "RB", "KC", { espn_id: 4567048 }),
  player("3", "Jared", "Goff", "QB", "DET"),
  player("4", "Backup", "Back", "RB", "LAR"),
  player("5", "Team", "Mate", "WR", "LAR"),
  player("6", "Other", "Guy", "WR", "DET"),
]);

// ---------- RSS ----------

const ROTOWIRE = `<?xml version="1.0"?><rss><channel>
  <item>
    <guid>nfl647450</guid>
    <title>Puka Nacua: Lands on injured reserve</title>
    <link>https://www.rotowire.com//football/player/puka-nacua-16790</link>
    <description>The Rams placed Nacua (knee) on IR Thursday &amp; more.

    Visit RotoWire.com for more analysis on this update.</description>
    <pubDate>Thu, 12 Nov 2026 4:39:00 PM PST</pubDate>
  </item>
  <item>
    <guid>nfl1</guid>
    <title><![CDATA[Kenneth Walker: Back at practice]]></title>
    <link>https://www.rotowire.com/football/player/kenneth-walker-99999</link>
    <description>Walker returned to practice.</description>
    <pubDate>Thu, 12 Nov 2026 10:00:00 AM EST</pubDate>
  </item>
</channel></rss>`;

test("parses RSS items, CDATA and entities", () => {
  const items = parseRss(ROTOWIRE);
  assert.equal(items.length, 2);
  assert.equal(items[0].guid, "nfl647450");
  assert.match(items[0].description, /on IR Thursday & more/);
  assert.equal(items[1].title, "Kenneth Walker: Back at practice");
  assert.equal(decodeEntities("A&#39;s &lt;b&gt; &#x41;"), "A's <b> A");
});

test("parses RSS dates with US zone names and 12-hour clocks", () => {
  assert.equal(parseRssDate("Thu, 12 Nov 2026 4:39:00 PM PST"), "2026-11-13T00:39:00.000Z");
  assert.equal(parseRssDate("Thu, 12 Nov 2026 10:00:00 AM EST"), "2026-11-12T15:00:00.000Z");
  assert.equal(parseRssDate("Thu, 12 Nov 2026 12:05:00 AM EST"), "2026-11-12T05:05:00.000Z");
  assert.equal(parseRssDate(""), null);
});

// ---------- News ----------

test("normalizes names for matching", () => {
  assert.equal(normalizeName("Kenneth Walker III"), "kenneth walker");
  assert.equal(normalizeName("Ja'Marr Chase"), "jamarr chase");
  assert.equal(normalizeName("Amon-Ra St. Brown"), "amonra st brown");
});

test("matches Rotowire news by Rotowire ID, then by unique name", () => {
  const index = buildPlayerIndex(players);
  const news = parseRotowireNews(ROTOWIRE, index);
  assert.deepEqual(news[0].player_ids, ["1"]);
  assert.equal(news[0].kind, "injury");
  assert.doesNotMatch(news[0].summary, /Visit RotoWire/);
  assert.equal(news[0].url, "https://www.rotowire.com/football/player/puka-nacua-16790");
  // no Rotowire ID on file: falls back to the name before the colon
  assert.deepEqual(news[1].player_ids, ["2"]);
  assert.equal(news[1].kind, "returning");
});

test("name fallback refuses ambiguous names", () => {
  const dupes = new Map([
    player("a", "Josh", "Allen", "QB", "BUF"),
    player("b", "Josh", "Allen", "LB", "JAX"),
  ]);
  const xml = `<rss><item><guid>g</guid><title>Josh Allen: Limited</title><link>x</link></item></rss>`;
  assert.deepEqual(parseRotowireNews(xml, buildPlayerIndex(dupes))[0].player_ids, []);
});

test("parses ESPN news, skips video and caps tagged players", () => {
  const index = buildPlayerIndex(players);
  const news = parseEspnNews(
    {
      articles: [
        {
          id: 1,
          type: "HeadlineNews",
          headline: "Rams put WR Puka Nacua on IR with knee, toe injuries",
          published: "2026-11-12T20:00:00Z",
          links: { web: { href: "https://espn.com/a" } },
          categories: [{ type: "athlete", athleteId: 4426515 }, { type: "team" }],
        },
        { id: 2, type: "Media", headline: "Highlights" },
      ],
    },
    index,
  );
  assert.equal(news.length, 1);
  assert.equal(news[0].id, "espn:1");
  assert.deepEqual(news[0].player_ids, ["1"]);
  assert.equal(news[0].kind, "injury");
});

test("classifies news headlines", () => {
  assert.equal(classifyNews("X: Logs full practice Thursday"), "returning");
  assert.equal(classifyNews("X: Activated from injured reserve"), "returning");
  assert.equal(classifyNews("X: Ruled out for Sunday"), "injury");
  assert.equal(classifyNews("X: Released by Jets"), "transaction");
  assert.equal(classifyNews("X: Takes over as lead back"), "role");
  assert.equal(classifyNews("X: Talks about the weather"), "general");
});

test("merges news without duplicates, newest first", () => {
  const a = { id: "a", published: "2026-11-10T00:00:00Z", title: "old" };
  const b = { id: "b", published: "2026-11-12T00:00:00Z", title: "new" };
  const merged = mergeNews([a], [b, { ...a, title: "updated" }]);
  assert.deepEqual(merged.map((n) => n.id), ["b", "a"]);
  assert.equal(merged[1].title, "updated");
  assert.equal(mergeNews([], [a, b], 1).length, 1);
});

test("tags news as mine, league or free agent", () => {
  const items = [
    { id: "1", player_ids: ["1"] },
    { id: "2", player_ids: ["2"] },
    { id: "3", player_ids: ["3"] },
    { id: "4", player_ids: [] },
    { id: "5", player_ids: ["2", "1"] },
  ];
  const tagged = tagNews(items, {
    mine: new Set(["1"]),
    owners: new Map([["1", "Me"], ["2", "Rival"]]),
    players,
  });
  assert.deepEqual(
    tagged.map((t) => t.relevance),
    ["mine", "league", "free_agent", "none", "mine"],
  );
  assert.equal(tagged[1].players[0].owner, "Rival");
});

// ---------- Live ----------

const SCOREBOARD = {
  events: [
    {
      id: "g1",
      date: "2026-11-13T01:15Z",
      status: { clock: 450, period: 3, type: { state: "in", shortDetail: "7:30 - 3rd" } },
      competitions: [
        {
          competitors: [
            { homeAway: "home", score: "17", team: { id: "14", abbreviation: "LAR" } },
            { homeAway: "away", score: "10", team: { id: "28", abbreviation: "WSH" } },
          ],
          situation: {
            possession: "14",
            isRedZone: true,
            downDistanceText: "1st & Goal at WSH 5",
            lastPlay: { text: " Pass to P.Nacua for 12 yards " },
          },
        },
      ],
    },
    {
      id: "g2",
      date: "2026-11-15T18:00Z",
      status: { type: { state: "pre", shortDetail: "Sun 1:00 PM" } },
      competitions: [
        {
          competitors: [
            { homeAway: "home", score: "0", team: { id: "8", abbreviation: "DET" } },
            { homeAway: "away", score: "0", team: { id: "12", abbreviation: "KC" } },
          ],
        },
      ],
    },
  ],
};

test("parses the ESPN scoreboard and maps team codes to Sleeper's", () => {
  const games = parseScoreboard(SCOREBOARD);
  assert.equal(games.length, 2);
  const g = games[0];
  assert.equal(g.away.team, "WAS");
  assert.equal(g.home.score, 17);
  assert.equal(g.possession, "LAR");
  assert.equal(g.red_zone, true);
  assert.equal(g.last_play, "Pass to P.Nacua for 12 yards");
  assert.equal(g.fraction_left, (900 + 450) / 3600);
  assert.equal(games[1].fraction_left, 1);
  assert.equal(games[1].down_distance, null);
});

test("game time left", () => {
  assert.equal(fractionLeft("pre", 0, 0), 1);
  assert.equal(fractionLeft("post", 4, 0), 0);
  assert.equal(fractionLeft("in", 1, 900), 1);
  assert.equal(fractionLeft("in", 4, 0), 0);
  assert.ok(fractionLeft("in", 5, 300) < 0.05);
});

test("detects when one of your players is in a game", () => {
  const byTeam = gamesByTeam(parseScoreboard(SCOREBOARD));
  assert.equal(anyPlaying(["1"], players, byTeam), true); // LAR is live
  assert.equal(anyPlaying(["3"], players, byTeam), false); // DET not started
  assert.equal(anyPlaying([], players, byTeam), false);
});

test("builds stat lines by position", () => {
  assert.equal(
    statLine({ pass_att: 27, pass_cmp: 18, pass_yd: 241, pass_td: 2, rush_att: 3, rush_yd: 12 }, "QB"),
    "18/27 241 yd 2 TD · 3 car 12 yd",
  );
  assert.equal(statLine({ rec: 6, rec_tgt: 8, rec_yd: 74, rec_td: 1 }, "WR"), "6 rec (8 tgt) 74 yd 1 TD");
  assert.equal(statLine({ fgm: 2, fga: 3, xpm: 1 }, "K"), "2/3 FG · 1 XP");
  assert.equal(statLine(undefined, "WR"), "");
});

function sides() {
  const byTeam = gamesByTeam(parseScoreboard(SCOREBOARD));
  const projections = new Map([["1", 16], ["3", 20], ["2", 12]]);
  const me = liveSide({
    matchup: { roster_id: 1, matchup_id: 1, points: 10, starters: ["1", "3", "0"], players_points: { 1: 10, 3: 0 } },
    teamName: "Me",
    slots: ["WR", "QB", "FLEX"],
    players,
    byTeam,
    projections,
    stats: { 1: { rec: 2, rec_tgt: 3, rec_yd: 40 } },
  });
  const opp = liveSide({
    matchup: { roster_id: 2, matchup_id: 1, points: 30, starters: ["2"], players_points: { 2: 30 } },
    teamName: "Them",
    slots: ["RB"],
    players,
    byTeam,
    projections,
    stats: {},
  });
  return { me, opp };
}

test("live side: points, projected finals and game state", () => {
  const { me, opp } = sides();
  assert.equal(me.starters.length, 2); // empty slot skipped
  const puka = me.starters[0];
  assert.equal(puka.game.state, "in");
  assert.equal(puka.game.has_ball, true);
  assert.equal(puka.game.red_zone, true);
  assert.equal(puka.game.opponent, "vs WAS");
  assert.equal(puka.stat_line, "2 rec (3 tgt) 40 yd");
  assert.equal(puka.projected_final, 16); // 10 + 16 * 0.375
  assert.equal(me.starters[1].projected_final, 20); // not started: full projection
  assert.equal(me.projected_final, 36);
  assert.equal(me.playing_now, 1);
  assert.equal(me.yet_to_play, 1);
  assert.equal(opp.starters[0].game.state, "pre"); // KC @ DET
  assert.equal(opp.projected_final, 42);
});

test("win probability favors the projected leader and is certain when done", () => {
  const { me, opp } = sides();
  const p = winProbability(me, opp);
  assert.ok(p > 0 && p < 0.5, `got ${p}`);
  const done = (s, pts) => ({ ...s, projected_final: pts, starters: [{ points: pts, projected_final: pts }] });
  assert.equal(winProbability(done(me, 100), done(opp, 90)), 1);
  assert.equal(winProbability(done(me, 80), done(opp, 90)), 0);
});

test("score events report point changes between polls", () => {
  const { me } = sides();
  const later = { ...me, starters: me.starters.map((p) => (p.player_id === "1" ? { ...p, points: 16.5 } : p)) };
  const events = scoreEvents(me, later, "mine", "t");
  assert.equal(events.length, 1);
  assert.equal(events[0].delta, 6.5);
  assert.equal(events[0].total, 16.5);
  assert.deepEqual(scoreEvents(null, me, "mine"), []);
});

// ---------- Analysis ----------

const SCORING = { rec: 0.5, rec_yd: 0.1, rec_td: 6, rush_yd: 0.1, rush_td: 6, pass_yd: 0.04, pass_td: 4 };

test("league points and projections use league scoring", () => {
  assert.equal(leaguePoints({ rec: 5, rec_yd: 60, rec_td: 1, junk: 99 }, SCORING), 14.5);
  const map = projectionMap(
    {
      1: { gp: 1, rec: 4, rec_yd: 50 },
      2: { gp: 1, pts_half_ppr: 7.5 }, // no raw stats: Sleeper's total
      3: { adp_dd_ppr: 1000 }, // not playing
    },
    SCORING,
  );
  assert.equal(map.get("1"), 7);
  assert.equal(map.get("2"), 7.5);
  assert.equal(map.has("3"), false);
});

function weekRows() {
  const rows = [];
  for (let week = 1; week <= 5; week++) {
    const late = week >= 4;
    // Backup RB "4" takes over in weeks 4-5; "5" is steady
    rows.push(
      { player_id: "4", week, team: "LAR", opponent: "SF", stats: { gms_active: 1, off_snp: late ? 50 : 10, tm_off_snp: 60, rush_att: late ? 18 : 3, rec_tgt: late ? 4 : 0, rush_yd: late ? 80 : 10 } },
      { player_id: "5", week, team: "LAR", opponent: "SF", stats: { gms_active: 1, off_snp: 55, tm_off_snp: 60, rec_tgt: 8, rec: 5, rec_yd: 60 } },
      { player_id: "6", week, team: "DET", opponent: week % 2 ? "SEA" : "SF", stats: { gms_active: 1, rec: 2, rec_yd: 20 } },
    );
  }
  return rows;
}

test("usage trends find a backup whose role is growing", () => {
  const trends = usageTrends(weekRows(), players, SCORING);
  const backup = trends.find((t) => t.player_id === "4");
  assert.equal(backup.recent.snap_share, 0.833);
  assert.equal(backup.earlier.snap_share, 0.167);
  assert.equal(backup.change.opportunities, 19);
  assert.match(backup.reason, /snaps 17% → 83%/);
  const steady = trends.find((t) => t.player_id === "5");
  assert.equal(steady.change.opportunities, 0);
  assert.equal(steady.reason, "");
  assert.ok(riserScore(backup) > riserScore(steady));
  // target share is per team per week
  assert.equal(steady.earlier.target_share, 1);
  assert.equal(steady.recent.target_share, 0.667);
});

test("points allowed ranks defenses per position (1 = easiest)", () => {
  const allowed = pointsAllowed(weekRows(), players, SCORING);
  const wr = allowed.get("WR");
  // SF faces LAR's WR (8.5/game) plus DET's WR in even weeks
  assert.equal(wr.get("SF").rank, 1);
  assert.equal(wr.get("SEA").rank, 2);
  assert.equal(wr.get("SEA").per_game, 3);
});

test("schedule outlook averages opponent ranks and flags playoff weeks", () => {
  const allowed = pointsAllowed(weekRows(), players, SCORING);
  const schedule = [
    { week: 6, home: "LAR", away: "SEA", status: "pre_game" },
    { week: 8, home: "SF", away: "LAR", status: "pre_game" },
  ];
  const [out] = scheduleOutlook({
    playerIds: ["5"],
    players,
    schedule,
    allowed,
    fromWeek: 6,
    throughWeek: 8,
    playoffStart: 8,
  });
  assert.deepEqual(
    out.weeks.map((w) => [w.week, w.opponent, w.home, w.rank, w.playoffs]),
    [
      [6, "SEA", true, 2, false],
      [7, null, false, null, false], // bye
      [8, "SF", false, 1, true],
    ],
  );
  assert.equal(out.ros_rank, 1.5);
  assert.equal(out.playoff_rank, 1);
  assert.equal(out.grade, "easy");
});

test("trade values map by Sleeper ID and FantasyCalc params match the league", () => {
  const map = tradeValues([
    { value: 9000, overallRank: 1, positionRank: 1, trend30Day: 50, player: { sleeperId: "1", name: "P", position: "WR" } },
    { value: 10, overallRank: 2, positionRank: 1, player: { sleeperId: null, name: "X", position: "RB" } },
  ]);
  assert.equal(map.size, 1);
  assert.equal(map.get("1").trend_30d, 50);
  assert.equal(
    fantasyCalcParams(
      { roster_positions: ["QB", "RB", "SUPER_FLEX"], scoring_settings: { rec: 1 }, settings: { type: 2 } },
      10,
    ),
    "isDynasty=true&numQbs=2&numTeams=10&ppr=1",
  );
  assert.equal(
    fantasyCalcParams({ roster_positions: ["QB", "WR"], scoring_settings: { rec: 0.5 }, settings: { type: 0 } }, 12),
    "isDynasty=false&numQbs=1&numTeams=12&ppr=0.5",
  );
});

// ---------- Activity ----------

import {
  effectiveText,
  mergeActivity,
  newsActivity,
  playActivity,
  playHeadline,
  playNamePattern,
  summaryPlays,
} from "../dist/feeds/activity.js";

test("play name patterns match ESPN's abbreviations", () => {
  const chase = playNamePattern({ first_name: "Ja'Marr", last_name: "Chase" });
  assert.ok(chase.test("J.Burrow pass short right to J.Chase for 12 yards"));
  assert.ok(chase.test("pass to Ja.Chase for 5 yards"));
  assert.ok(!chase.test("pass to K.Chase for 5 yards"));
  assert.ok(!chase.test("pass to J.Chasen for 5 yards"));
  const asb = playNamePattern({ first_name: "Amon-Ra", last_name: "St. Brown" });
  assert.ok(asb.test("pass short left to A.St. Brown to DET 40"));
  const walker = playNamePattern({ first_name: "Kenneth", last_name: "Walker III" });
  assert.ok(walker.test("K.Walker left end for 7 yards"));
});

test("play headlines read from the player's side and respect replay reversals", () => {
  const goff = playNamePattern({ first_name: "Jared", last_name: "Goff" });
  const lap = playNamePattern({ first_name: "Sam", last_name: "LaPorta" });
  const rec = { type: { text: "Pass Reception" }, text: "J.Goff pass short middle to S.LaPorta to DET 40 for 11 yards (X.Y)." };
  assert.equal(playHeadline(rec, goff), "Completion · 11 yds");
  assert.equal(playHeadline(rec, lap), "Catch · 11 yds");
  const td = { type: { text: "Passing Touchdown" }, text: "J.Goff pass short right to S.LaPorta for 3 yards, TOUCHDOWN." };
  assert.equal(playHeadline(td, goff), "TD pass · 3 yds");
  assert.equal(playHeadline(td, lap), "Receiving TD · 3 yds");
  const reversed = {
    type: { text: "Pass Incompletion" },
    text: "J.Goff pass to S.LaPorta for 14 yards. Challenged, and the play was REVERSED. J.Goff pass incomplete short left to S.LaPorta.",
  };
  assert.equal(effectiveText(reversed.text), "J.Goff pass incomplete short left to S.LaPorta.");
  assert.equal(playHeadline(reversed, goff), "Incompletion");
  assert.equal(playHeadline(reversed, lap), "Target · incomplete");
  assert.equal(
    playHeadline({ type: { text: "Rush" }, text: "D.Montgomery up the middle for -1 yards" }),
    "Rush · -1 yd",
  );
});

test("activity picks plays for your players by name or ESPN ID", () => {
  const summary = {
    drives: {
      previous: [
        {
          plays: [
            { id: "p1", text: "J.Goff pass to S.LaPorta for 9 yards", type: { text: "Pass Reception" }, period: { number: 1 }, clock: { displayValue: "10:00" }, wallclock: "2026-11-15T18:10:00Z" },
            { id: "p2", text: "D.Montgomery left end for 4 yards", type: { text: "Rush" }, period: { number: 1 }, clock: { displayValue: "9:20" }, wallclock: "2026-11-15T18:11:00Z" },
          ],
        },
      ],
      current: {
        plays: [
          { id: "p3", text: "Pass to someone", type: { text: "Pass Reception" }, participants: [{ athlete: { id: "999" } }], period: { number: 2 }, clock: { displayValue: "1:00" }, wallclock: "2026-11-15T18:30:00Z", scoringPlay: true },
          { id: "p3", text: "duplicate", wallclock: "2026-11-15T18:30:00Z" },
        ],
      },
    },
  };
  const plays = summaryPlays(summary);
  assert.equal(plays.length, 3);
  const roster = [
    { player_id: "L", player: { first_name: "Sam", last_name: "LaPorta", position: "TE", team: "DET", espn_id: 999 }, starter: true },
    { player_id: "D", player: { first_name: "Detroit", last_name: "Lions", position: "DEF", team: "DET" }, starter: true },
  ];
  const items = playActivity(plays, roster, "2026-11-15T18:00:00Z");
  assert.deepEqual(items.map((i) => i.id), ["play:p1:L", "play:p3:L"]);
  assert.equal(items[0].headline, "Catch · 9 yds");
  assert.equal(items[0].clock, "Q1 10:00");
  assert.equal(items[1].scoring, true);
});

test("activity merges plays and news about your players, newest first", () => {
  const news = [
    { id: "n1", relevance: "mine", title: "LaPorta: Full practice", summary: "", url: "u", published: "2026-11-14T00:00:00Z", players: [{ player_id: "L", name: "Sam LaPorta", position: "TE", team: "DET", owner: "Me" }] },
    { id: "n2", relevance: "league", title: "Other", published: "2026-11-16T00:00:00Z", players: [] },
  ];
  const fromNews = newsActivity(news, new Set(["L"]), new Set());
  assert.equal(fromNews.length, 1);
  assert.equal(fromNews[0].starter, false);
  const merged = mergeActivity([
    ...fromNews,
    { id: "a", at: "2026-11-15T18:00:00Z" },
    { id: "b", at: "2026-11-15T18:00:00Z" },
    { id: "a", at: "2026-11-15T18:00:00Z" },
  ]);
  assert.deepEqual(merged.map((m) => m.id), ["a", "b", "news:n1"]);
});
