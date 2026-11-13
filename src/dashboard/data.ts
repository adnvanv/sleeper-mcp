/**
 * Dashboard panel data. Built from the same Sleeper client, caches and
 * analysis modules the MCP tools use, so both always agree.
 */

import { sleeperClient } from "../sleeper-client.js";
import { defaultsResolver } from "../defaults.js";
import { loadLeagueData, findRosterForUser } from "../league-data.js";
import { computeAllPlay } from "../all-play.js";
import { findTrendingFreeAgents } from "../free-agents.js";
import { buildTransactionFeed } from "../transaction-feed.js";
import {
  byeTeams,
  nflOpponent,
  playerStats,
  startingSlots,
  teamName,
} from "../season.js";
import type { NFLGame, SleeperMatchup, SleeperPlayer } from "../types.js";
import { FeedPoller, type Topic } from "../feeds/poller.js";

const LIVE_SCHEDULE_MS = 5 * 60 * 1000;
const RISKY = new Set(["Out", "IR", "Doubtful", "Suspended", "PUP"]);
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface DashboardContext {
  leagueId: string;
  userId: string;
}

export async function resolveContext(): Promise<DashboardContext> {
  const [leagueId, userId] = await Promise.all([
    defaultsResolver.resolveLeagueId(),
    defaultsResolver.resolveUserId(),
  ]);
  return { leagueId, userId };
}

function playerName(p: SleeperPlayer | undefined, id: string): string {
  if (!p) return id;
  return `${p.first_name || ""} ${p.last_name || ""}`.trim() || id;
}

/** Has this NFL team's game for the week finished? */
function gameFinished(schedule: NFLGame[], week: number, team?: string | null) {
  if (!team) return true;
  const game = schedule.find(
    (g) => g.week === week && (g.home === team || g.away === team),
  );
  return !game || game.status === "complete";
}

export async function getSummary(ctx: DashboardContext) {
  const data = await loadLeagueData(ctx.leagueId);
  const mine = findRosterForUser(data.rosters, ctx.userId);
  const me = data.users.find((u) => u.user_id === ctx.userId);
  const s = mine?.settings;
  return {
    league: data.league.name,
    season: data.league.season,
    season_type: data.nflState.season_type,
    week: data.currentWeek,
    last_scored_week: data.weeks.at(-1)?.week ?? null,
    playoff_week_start: data.league.settings.playoff_week_start ?? null,
    teams: data.rosters.length,
    you: mine
      ? {
          team_name: teamName(mine, me),
          record: s
            ? `${s.wins}-${s.losses}${s.ties ? `-${s.ties}` : ""}`
            : null,
        }
      : null,
  };
}

export async function getStandings(ctx: DashboardContext) {
  const data = await loadLeagueData(ctx.leagueId);
  const medianGame = data.league.settings.league_average_match === 1;
  const standings = computeAllPlay(data.weeks, data.rosters, data.users, {
    medianGame,
  }).map((r) => ({ ...r, is_you: r.owner_id === ctx.userId }));
  return {
    weeks_counted: data.weeks.map((w) => w.week),
    median_game: medianGame,
    standings,
  };
}

export async function getMatchups(ctx: DashboardContext) {
  const data = await loadLeagueData(ctx.leagueId);
  const week = data.currentWeek;
  const [matchups, schedule] = await Promise.all([
    sleeperClient.getMatchups(ctx.leagueId, week),
    sleeperClient.getSchedule(data.league.season, LIVE_SCHEDULE_MS),
  ]);
  const userMap = new Map(data.users.map((u) => [u.user_id, u]));
  const myRoster = findRosterForUser(data.rosters, ctx.userId);

  const side = (m: SleeperMatchup) => {
    const roster = data.rosters.find((r) => r.roster_id === m.roster_id);
    const starters = (m.starters || []).filter((id) => id && id !== "0");
    return {
      roster_id: m.roster_id,
      team_name: roster
        ? teamName(roster, userMap.get(roster.owner_id))
        : `Team ${m.roster_id}`,
      points: r2(m.points || 0),
      yet_to_play: starters.filter(
        (id) => !gameFinished(schedule, week, data.players.get(id)?.team),
      ).length,
      is_you: m.roster_id === myRoster?.roster_id,
    };
  };

  const groups = new Map<number, SleeperMatchup[]>();
  for (const m of matchups || []) {
    if (m.matchup_id == null) continue;
    groups.set(m.matchup_id, [...(groups.get(m.matchup_id) || []), m]);
  }
  const games = [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([matchup_id, teams]) => ({
      matchup_id,
      teams: teams.map(side),
    }))
    .sort(
      (a, b) =>
        Number(b.teams.some((t) => t.is_you)) -
        Number(a.teams.some((t) => t.is_you)),
    );

  return { week, games };
}

export async function getRoster(ctx: DashboardContext) {
  const data = await loadLeagueData(ctx.leagueId);
  const week = data.currentWeek;
  const mine = findRosterForUser(data.rosters, ctx.userId);
  if (!mine) throw new Error("You are not in this league");

  const [matchups, schedule] = await Promise.all([
    sleeperClient.getMatchups(ctx.leagueId, week),
    sleeperClient.getSchedule(data.league.season, LIVE_SCHEDULE_MS),
  ]);
  const myMatchup = (matchups || []).find(
    (m) => m.roster_id === mine.roster_id,
  );
  const stats = playerStats(data.weeks);
  const byes = byeTeams(schedule, week);
  const slots = startingSlots(data.league.roster_positions);

  const row = (id: string, slot: string) => {
    const p = data.players.get(id);
    const team = p?.team || null;
    const injury = p?.injury_status || null;
    const onBye = !!team && byes.has(team);
    return {
      player_id: id,
      slot,
      name: playerName(p, id),
      position: p?.position || null,
      team,
      nfl_opponent: nflOpponent(schedule, week, team),
      injury_status: injury,
      on_bye: onBye,
      points: r2(myMatchup?.players_points?.[id] ?? 0),
      season_ppg: stats.get(id)?.ppg ?? null,
      warning:
        slot !== "BN" && slot !== "IR" && slot !== "TAXI"
          ? onBye
            ? "Starting a player on bye"
            : injury && RISKY.has(injury)
              ? `Starting a player listed ${injury}`
              : null
          : null,
    };
  };

  const starterIds = myMatchup?.starters?.length
    ? myMatchup.starters
    : mine.starters || [];
  const starters = slots.map((slot, i) => {
    const id = starterIds[i];
    if (!id || id === "0") {
      return {
        player_id: null,
        slot,
        name: "Empty",
        position: null,
        team: null,
        nfl_opponent: null,
        injury_status: null,
        on_bye: false,
        points: 0,
        season_ppg: null,
        warning: "Empty starting slot",
      };
    }
    return row(id, slot);
  });
  const used = new Set(starterIds);
  const reserve = new Set(mine.reserve || []);
  const taxi = new Set(mine.taxi || []);
  const bench = (mine.players || [])
    .filter((id) => !used.has(id) && !reserve.has(id) && !taxi.has(id))
    .map((id) => row(id, "BN"))
    .sort((a, b) => (b.season_ppg ?? 0) - (a.season_ppg ?? 0));

  return {
    week,
    team_name: teamName(
      mine,
      data.users.find((u) => u.user_id === mine.owner_id),
    ),
    points: r2(myMatchup?.points ?? 0),
    starters,
    bench,
    reserve: [...reserve].map((id) => row(id, "IR")),
    taxi: [...taxi].map((id) => row(id, "TAXI")),
    warnings: starters.filter((s) => s.warning).length,
  };
}

export async function getFreeAgents(ctx: DashboardContext) {
  const [league, rosters, trending, players] = await Promise.all([
    sleeperClient.getLeague(ctx.leagueId),
    sleeperClient.getLeagueRosters(ctx.leagueId),
    sleeperClient.getTrendingPlayers("add", 24, 100),
    sleeperClient.getAllPlayers(),
  ]);
  const { free_agents, rostered_skipped } = findTrendingFreeAgents(
    trending,
    rosters,
    players,
    { limit: 12, rosterPositions: league.roster_positions },
  );
  return { free_agents, rostered_skipped, checked: trending.length };
}

export async function getTransactions(ctx: DashboardContext) {
  const data = await loadLeagueData(ctx.leagueId);
  const week = data.currentWeek;
  const weeks: number[] = [];
  for (let w = Math.max(1, week - 2); w <= week; w++) weeks.push(w);
  const lists = await Promise.all(
    weeks.map((w) => sleeperClient.getTransactions(ctx.leagueId, w)),
  );
  const feed = buildTransactionFeed(
    lists.flat().filter(Boolean),
    data.rosters,
    data.users,
    data.players,
  );
  return {
    since_week: weeks[0],
    counts: feed.counts,
    items: feed.items.slice(0, 30),
  };
}

// ---------- Background feeds (live scores, news, usage, schedule, values) ----------

let poller: FeedPoller | null = null;

/** Start the background poller once; panels below read its latest data. */
export async function startFeeds(livePollMs: number): Promise<FeedPoller> {
  if (poller) return poller;
  const ctx = await resolveContext();
  poller = new FeedPoller({ ...ctx, livePollMs });
  await poller.start();
  return poller;
}

const feedPanel = (topic: Topic) => async () => {
  if (!poller) throw new Error("Live feeds are not running");
  return (await poller.waitFor(topic)).data;
};

export const panels = {
  summary: getSummary,
  standings: getStandings,
  matchups: getMatchups,
  roster: getRoster,
  "free-agents": getFreeAgents,
  transactions: getTransactions,
  activity: feedPanel("activity"),
  live: feedPanel("live"),
  news: feedPanel("news"),
  usage: feedPanel("usage"),
  outlook: feedPanel("outlook"),
  values: feedPanel("values"),
  feeds: feedPanel("status"),
} as const;

export type PanelName = keyof typeof panels;
