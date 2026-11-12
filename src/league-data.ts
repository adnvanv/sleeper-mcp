/**
 * Loads everything a league-wide analysis needs in one place. Shared by the
 * MCP tool handlers and the dashboard so both see the same data and caches.
 */

import { sleeperClient } from "./sleeper-client.js";
import { resolveThroughWeek } from "./all-play.js";
import { playedWeeks, type WeekScores } from "./season.js";
import type {
  NFLGame,
  SleeperLeague,
  SleeperLeagueUser,
  SleeperNFLState,
  SleeperPlayer,
  SleeperRoster,
} from "./types.js";

export interface LeagueData {
  league: SleeperLeague;
  rosters: SleeperRoster[];
  users: SleeperLeagueUser[];
  nflState: SleeperNFLState;
  /** NFL week the league is in now (display week during the season). */
  currentWeek: number;
  /** Fully scored regular-season weeks, oldest first. */
  weeks: WeekScores[];
  players: Map<string, SleeperPlayer>;
  schedule: NFLGame[];
}

export async function loadLeagueData(
  leagueId: string,
  options: { throughWeek?: number } = {},
): Promise<LeagueData> {
  const [league, rosters, users, nflState, players] = await Promise.all([
    sleeperClient.getLeague(leagueId),
    sleeperClient.getLeagueRosters(leagueId),
    sleeperClient.getLeagueUsers(leagueId),
    sleeperClient.getNFLState(),
    sleeperClient.getAllPlayers(),
  ]);

  const currentWeek = Math.max(nflState.display_week || nflState.week || 1, 1);
  const lastWeek = resolveThroughWeek({
    requested: options.throughWeek,
    lastScoredWeek: league.settings.last_scored_leg,
    currentWeek,
    playoffWeekStart: league.settings.playoff_week_start,
  });
  const startWeek = league.settings.start_week || 1;

  const [weeks, schedule] = await Promise.all([
    lastWeek >= startWeek
      ? sleeperClient.getSeasonMatchups(
          leagueId,
          startWeek,
          lastWeek,
          currentWeek,
        )
      : Promise.resolve([]),
    sleeperClient.getSchedule(league.season || nflState.season),
  ]);

  return {
    league,
    rosters,
    users,
    nflState,
    currentWeek,
    weeks: playedWeeks(weeks),
    players,
    schedule,
  };
}

export function findRosterForUser(
  rosters: SleeperRoster[],
  userId: string,
): SleeperRoster | undefined {
  return rosters.find(
    (r) => r.owner_id === userId || (r as any).co_owners?.includes(userId),
  );
}
