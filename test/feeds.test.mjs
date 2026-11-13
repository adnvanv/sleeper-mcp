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

// ---------- Per-player news + advisor ----------

import { parseEspnPlayerNews, newsFingerprint } from "../dist/feeds/news.js";
import { advise, lineupByWeek } from "../dist/feeds/advisor.js";

test("parses ESPN per-player news and dedupes against the Rotowire RSS copy", () => {
  const items = parseEspnPlayerNews(
    {
      feed: [
        { id: 1, type: "Rotowire", headline: "The Rams placed Nacua (knee) on injured reserve Thursday.", story: "<p>He'll miss at least four games.</p>", published: "2026-11-12T23:00:00Z" },
        { id: 2, type: "Story", headline: "Week 9 winners and losers", published: "2026-11-09T00:00:00Z" },
        { id: 3, type: "Story", headline: "Is Nacua's injury a season-ender?", published: "2026-11-12T00:00:00Z" },
        { id: 4, type: "Media", headline: "Nacua video", published: "2026-11-12T00:00:00Z" },
      ],
    },
    "1",
    "Nacua",
  );
  assert.deepEqual(items.map((i) => i.id), ["espn:1", "espn:3"]);
  assert.equal(items[0].source, "Rotowire");
  assert.equal(items[0].summary, "He'll miss at least four games.");
  assert.equal(items[0].kind, "injury");
  assert.deepEqual(items[0].player_ids, ["1"]);

  const rss = {
    id: "rotowire:nfl1",
    title: "Puka Nacua: Lands on injured reserve",
    summary: "The Rams placed Nacua (knee) on injured reserve Thursday.",
    published: "2026-11-12T23:00:00Z",
    player_ids: ["1"],
    fingerprint: newsFingerprint("1", "The Rams placed Nacua (knee) on injured reserve Thursday."),
  };
  const merged = mergeNews([rss], items);
  assert.equal(merged.length, 2); // the richer ESPN copy replaced the RSS one
  assert.ok(merged.some((n) => n.id === "espn:1"));
  assert.ok(!merged.some((n) => n.id === "rotowire:nfl1"));
  // and the other way round: a thinner copy arriving later is ignored
  assert.equal(mergeNews(merged, [rss]).length, 2);
});

function advisorLeague() {
  const p = (id, name, position, team) => [id, { player_id: id, first_name: name, last_name: "X", position, team, fantasy_positions: [position] }];
  const players = new Map([
    p("q1", "MyQB", "QB", "AAA"),
    p("r1", "MyRB1", "RB", "AAA"),
    p("r2", "MyRB2", "RB", "BBB"), // on bye week 2
    p("r3", "MyRB3", "RB", "AAA"), // deep bench, never starts
    p("f1", "FreeRB", "RB", "CCC"),
    p("f2", "FreeQB", "QB", "CCC"),
    p("x1", "TakenRB", "RB", "DDD"),
  ]);
  const proj = (vals) => new Map(Object.entries(vals));
  const projections = new Map([
    [1, proj({ q1: 20, r1: 15, r2: 12, r3: 3, f1: 10, f2: 18, x1: 30 })],
    [2, proj({ q1: 20, r1: 15, r2: 0, r3: 3, f1: 10, f2: 18, x1: 30 })],
    [3, proj({ q1: 20, r1: 15, r2: 12, r3: 3, f1: 10, f2: 18, x1: 30 })],
  ]);
  const empty = new Map();
  return {
    fromWeek: 1,
    throughWeek: 3,
    playoffStart: 3,
    rosterPositions: ["QB", "RB", "RB", "BN", "BN"],
    myIds: ["q1", "r1", "r2", "r3"],
    rostered: new Set(["q1", "r1", "r2", "r3", "x1"]),
    players,
    projections,
    injuries: empty,
    history: empty,
    usage: empty,
    playoffRank: empty,
    byeWeek: new Map([["r2", 2]]),
    trendingAdds: new Map([["f1", 5000]]),
    values: empty,
    news: empty,
    waivers: new Map([["f1", "2026-11-14T08:00:00Z"]]),
    now: new Date("2026-11-13T00:00:00Z"),
  };
}

test("lineup totals per week use the best eligible players", () => {
  const input = advisorLeague();
  const weeks = lineupByWeek(input.myIds, input);
  assert.deepEqual([...weeks.values()], [47, 38, 47]); // week 2: r2 on bye, r3 fills in
});

test("advisor finds the swap that raises ROS starting points and explains it", () => {
  const input = advisorLeague();
  const result = advise(input);
  assert.equal(result.team_ros_points, 132);
  const [best] = result.moves;
  // FreeRB covers MyRB2's bye: +7 in week 2; dropping the never-used r3 costs 0 elsewhere
  assert.equal(best.add.player_id, "f1");
  assert.equal(best.drop.player_id, "r3");
  assert.equal(best.ros_gain, 7);
  assert.equal(best.playoff_gain, 0);
  assert.equal(best.add.on_waivers_until, "2026-11-14T08:00:00Z");
  assert.match(best.add_reasons.join(" "), /Expect 10 pts a game/);
  assert.match(best.add_reasons.join(" "), /5K Sleeper managers added him/);
  // FreeQB is a backup behind a better QB: no gain, so not suggested
  assert.ok(!result.moves.some((m) => m.add.player_id === "f2"));
  // rostered elsewhere: never suggested
  assert.ok(!result.moves.some((m) => m.add.player_id === "x1"));
});

test("drop candidates rank by what each player adds to your lineups", () => {
  const { drops } = advise(advisorLeague());
  assert.deepEqual(drops.map((d) => [d.player.player_id, d.ros_contribution, d.verdict]), [
    ["r3", 3, "expendable"],
    ["r2", 18, "keep"],
    ["r1", 39, "keep"], // without him, r3 starts every week and week 2 has a hole
    ["q1", 60, "keep"],
  ]);
  assert.match(drops[0].reasons.join(" "), /Adds only 3 starting points/);
});

// ---------- Signals: news reading, games played, adjusted outlook ----------

import { readNews, quoteAround, outlook, playedGames, pointsPerOpportunity } from "../dist/feeds/signals.js";
import { usageDirection } from "../dist/feeds/advisor.js";

const DELL_NEWS = [
  {
    id: "a",
    source: "Rotowire",
    title: "Dell (hand) was limited in Wednesday's practice, Mary Kay Cabot of The Cleveland Plain Dealer reports.",
    summary:
      "Dell operated as the Texans' third receiver for much of last Sunday's 44-22 win over the Chargers, running 22 routes on C.J. Stroud's 38 dropbacks. In just his second game since Week 16 of the 2024 campaign, Dell turned nine targets into five catches for 104 yards and a touchdown.",
    published: "2026-11-11T22:42:49Z",
    player_ids: ["9502"],
  },
  {
    id: "b",
    source: "Rotowire",
    title: "Dell (knee) is active for Sunday's game against the Giants.",
    summary: "Dell is ready to take the field for the first time since Dec. 21, 2024, but he'll likely be eased into the action.",
    published: "2026-10-25T17:00:00Z",
    player_ids: ["9502"],
  },
];

test("reads return, practice, role, routes and ramp-up from news text", () => {
  const s = readNews(DELL_NEWS, new Date("2026-11-13T00:00:00Z"));
  assert.equal(s.returned, true);
  assert.equal(s.practice, "limited");
  assert.equal(s.role_rank, 3);
  assert.equal(s.route_share, 0.58);
  assert.equal(s.ramping, true);
  assert.equal(s.out, false);
  assert.ok(s.quotes.some((q) => q.text.includes("running 22 routes on C.J. Stroud's 38 dropbacks.")));
  assert.ok(s.quotes.every((q) => !q.text.endsWith("..")));
  // old news doesn't count
  assert.equal(readNews(DELL_NEWS, new Date("2027-01-01T00:00:00Z")).returned, false);
});

test("quotes keep initials inside a sentence", () => {
  const text = "First sentence. He ran routes on C.J. Stroud's dropbacks. Last one.";
  assert.equal(quoteAround(text, text.indexOf("routes")), "He ran routes on C.J. Stroud's dropbacks.");
});

test("games played skip weeks a player was inactive, and usage is valued per position", () => {
  const rows = [
    { player_id: "d", week: 5, team: "HOU", stats: { gms_active: 1 } }, // on IR
    { player_id: "d", week: 7, team: "HOU", stats: { gms_active: 1, off_snp: 14, tm_off_snp: 61, rec_tgt: 1, rec: 1, rec_yd: 43 } },
    { player_id: "d", week: 9, team: "HOU", stats: { gms_active: 1, off_snp: 33, tm_off_snp: 70, rec_tgt: 9, rec: 4, rec_yd: 105, rec_td: 1 } },
  ];
  const scoring = { rec: 0.5, rec_yd: 0.1, rec_td: 6 };
  const ppo = pointsPerOpportunity(rows, () => "WR", scoring);
  assert.equal(ppo.get("WR").per_target, 2.33); // (4.8 + 18.5) / 10
  const games = playedGames(rows, "WR", scoring, ppo);
  assert.deepEqual(games.map((g) => g.week), [7, 9]);
  assert.equal(games[1].points, 18.5);
  assert.equal(games[1].snap_share, 0.47);
  assert.equal(games[1].expected_points, 21);
});

const GAMES = [
  { week: 7, points: 5, snap_share: 0.23, targets: 1, carries: 0, expected_points: 1.3 },
  { week: 9, points: 18.5, snap_share: 0.47, targets: 9, carries: 0, expected_points: 12.7 },
];
const quiet = { returned: false, practice: null, role_rank: null, route_share: null, ramping: false, out: false, quotes: [] };

test("outlook leans on recent usage more when the market agrees", () => {
  const market = { adds_24h: 0, add_rank: null, drops_24h: 0, drop_rank: null };
  const base = outlook({ name: "D", position: "WR", projectedPpg: 5.1, games: GAMES, news: quiet, market });
  assert.equal(base.recent_weight, 0.3); // 2 games
  const hot = outlook({
    name: "D",
    position: "WR",
    projectedPpg: 5.1,
    games: GAMES,
    news: readNews(DELL_NEWS, new Date("2026-11-13T00:00:00Z")),
    market: { adds_24h: 133800, add_rank: 17, drops_24h: 0, drop_rank: null },
    seasonWeeks: 9,
  });
  // 0.3 for two games, +0.2 market, +0.1 back from injury, -0.1 WR3 role
  assert.equal(hot.recent_weight, 0.5);
  assert.ok(hot.adjusted_ppg > base.adjusted_ppg);
  assert.ok(hot.adjusted_ppg > 5.1 && hot.adjusted_ppg < hot.recent_ppg);
  assert.ok(hot.hold_flags.some((f) => /133\.8K adds/.test(f)));
  assert.ok(hot.notes.some((n) => /Back from injury: 2 games/.test(n)));
  // a regular who just "returned to action" after a week off isn't back from injury
  const regular = outlook({
    name: "C", position: "WR", projectedPpg: 15, games: [...GAMES, ...GAMES, ...GAMES, GAMES[0]],
    news: { ...quiet, returned: true }, market, seasonWeeks: 9,
  });
  assert.ok(!regular.notes.some((n) => /Back from injury/.test(n)));
  // still sidelined (last game weeks ago) isn't "back" either
  const sidelined = outlook({ name: "M", position: "RB", projectedPpg: 9, games: [{ ...GAMES[0], week: 5 }], news: { ...quiet, returned: true }, market, seasonWeeks: 9 });
  assert.ok(!sidelined.notes.some((n) => /Back from injury/.test(n)));
  // QBs lean on the projection
  const qb = outlook({ name: "Q", position: "QB", projectedPpg: 19, games: GAMES, news: quiet, market: { adds_24h: 90000, add_rank: 5, drops_24h: 0, drop_rank: null } });
  assert.ok(qb.recent_weight <= 0.25);
  // no projection at all: use recent usage
  assert.equal(outlook({ name: "D", position: "WR", projectedPpg: null, games: GAMES, news: quiet, market }).adjusted_ppg, base.recent_ppg);
});

test("projections stay Sleeper's unless the blend is switched on", () => {
  const input = advisorLeague();
  input.outlooks = new Map([
    ["r3", { projected_ppg: 3, adjusted_ppg: 6, notes: [], hold_flags: ["Other managers are chasing him"], news: { quotes: [] } }],
  ]);
  const r3 = advise(input).drops.find((d) => d.player.player_id === "r3");
  assert.equal(r3.player.ros_ppg, 3);
  assert.notEqual(r3.verdict, "drop"); // hold flags still protect him
});

test("advisor uses the adjusted estimate when the blend is on", () => {
  const input = advisorLeague();
  input.useBlend = true;
  // r3 is barely projected but has been used heavily: recent usage says 6 a game
  input.outlooks = new Map([
    ["r3", { projected_ppg: 3, adjusted_ppg: 6, notes: ["n"], hold_flags: ["Other managers are chasing him"], news: { quotes: [] } }],
  ]);
  const result = advise(input);
  const r3 = result.drops.find((d) => d.player.player_id === "r3");
  assert.equal(r3.player.ros_ppg, 6);
  assert.equal(r3.player.projected_ppg, 3);
  assert.notEqual(r3.verdict, "drop");
  assert.ok(r3.reasons.some((r) => r.startsWith("Hold? ")));
  // FreeRB still covers the week-2 bye better, but by 4 points, not 7
  assert.equal(result.moves[0].drop.player_id, "r3");
  assert.equal(result.moves[0].ros_gain, 4);
  assert.deepEqual(result.moves[0].cautions, ["Other managers are chasing him"]);
  // and an absurd gap is capped at 2.5x the projection
  input.outlooks.get("r3").adjusted_ppg = 30;
  assert.equal(advise(input).drops.find((d) => d.player.player_id === "r3").player.ros_ppg, 7.5);
});

test("usage direction separates growing, shrinking and mixed roles", () => {
  const u = (snap, opp) => ({ change: { snap_share: snap, opportunities: opp } });
  assert.equal(usageDirection(u(0.2, 3)), "up");
  assert.equal(usageDirection(u(-0.17, -4)), "down");
  assert.equal(usageDirection(u(-0.17, 3.2)), "mixed");
  assert.equal(usageDirection(u(0.01, 0.5)), null);
});

// ---------- Live pace (green / red) ----------

import { paceOf } from "../dist/feeds/live.js";

test("pace compares points with the projection for time played", () => {
  assert.equal(paceOf(0, 10, "pre", 1), null); // not started
  assert.equal(paceOf(0, null, "in", 0.5), null); // no projection
  assert.equal(paceOf(0, 10, "in", 0.95), "even"); // first minutes
  assert.equal(paceOf(2, 10, "in", 0.95), "good"); // early score
  assert.equal(paceOf(8, 10, "in", 0.5), "good"); // 8 vs 5 expected
  assert.equal(paceOf(5, 10, "in", 0.5), "even");
  assert.equal(paceOf(2, 10, "in", 0.5), "bad"); // 2 vs 5 expected
  assert.equal(paceOf(12, 10, "post", 0), "good"); // final beat projection
  assert.equal(paceOf(6, 10, "post", 0), "bad");
  assert.equal(paceOf(1.2, 1.5, "in", 0.5), "even"); // tiny gaps aren't flagged
});

test("live sides carry player and team pace", () => {
  const { me } = sides();
  const puka = me.starters.find((p) => p.player_id === "1");
  // 10 pts with 62.5% of the game played vs 16 projected (10 expected): even
  assert.equal(puka.pace, "even");
  assert.equal(me.starters.find((p) => p.player_id === "3").pace, null); // not started
  assert.equal(me.pace, "even");
});
