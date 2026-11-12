import type {
  SleeperPlayer,
  SleeperRoster,
  SleeperTrendingPlayer,
} from "./types.js";
import { SLOT_POSITIONS } from "./season.js";

/** Every player ID on any roster in the league, including IR and taxi. */
export function getRosteredPlayerIds(rosters: SleeperRoster[]): Set<string> {
  const ids = new Set<string>();
  for (const roster of rosters) {
    for (const list of [roster.players, roster.reserve, roster.taxi]) {
      for (const id of list || []) ids.add(id);
    }
  }
  return ids;
}

/**
 * Positions the league can actually start, from its roster slots.
 * Returns null when the league gives no slot info (don't filter).
 */
export function getLeaguePositions(
  rosterPositions?: string[],
): Set<string> | null {
  if (!rosterPositions?.length) return null;
  const positions = new Set<string>();
  for (const slot of rosterPositions) {
    for (const pos of SLOT_POSITIONS[slot] || []) positions.add(pos);
  }
  return positions.size ? positions : null;
}

export interface TrendingFreeAgent {
  player_id: string;
  name: string;
  position: string;
  fantasy_positions: string[];
  team: string | null;
  injury_status: string | null;
  trending_adds: number;
  trend_rank: number;
  search_rank: number | null;
}

export interface TrendingFreeAgentOptions {
  position?: string;
  limit?: number;
  rosterPositions?: string[];
}

/**
 * Cross-reference trending adds with league rosters. Keeps players nobody in
 * the league has, at positions the league uses, ordered by add count.
 */
export function findTrendingFreeAgents(
  trending: SleeperTrendingPlayer[],
  rosters: SleeperRoster[],
  players: Map<string, SleeperPlayer>,
  options: TrendingFreeAgentOptions = {},
): { free_agents: TrendingFreeAgent[]; rostered_skipped: number } {
  const { position, limit = 15, rosterPositions } = options;
  const rostered = getRosteredPlayerIds(rosters);
  const leaguePositions = getLeaguePositions(rosterPositions);
  const wanted = position?.toUpperCase();

  const freeAgents: TrendingFreeAgent[] = [];
  let rosteredSkipped = 0;

  const sorted = [...trending].sort((a, b) => b.count - a.count);
  sorted.forEach((trend, index) => {
    if (rostered.has(trend.player_id)) {
      rosteredSkipped++;
      return;
    }
    const player = players.get(trend.player_id);
    if (!player) return;

    const positions = player.fantasy_positions?.length
      ? player.fantasy_positions
      : player.position
        ? [player.position]
        : [];
    if (leaguePositions && !positions.some((p) => leaguePositions.has(p))) {
      return;
    }
    if (wanted && !positions.includes(wanted)) return;

    freeAgents.push({
      player_id: trend.player_id,
      name:
        `${player.first_name || ""} ${player.last_name || ""}`.trim() ||
        trend.player_id,
      position: player.position || positions[0] || "UNK",
      fantasy_positions: positions,
      team: player.team || null,
      injury_status: player.injury_status || null,
      trending_adds: trend.count,
      trend_rank: index + 1,
      search_rank: player.search_rank ?? null,
    });
  });

  return {
    free_agents: freeAgents.slice(0, limit),
    rostered_skipped: rosteredSkipped,
  };
}
