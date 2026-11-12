/**
 * Pure helpers shared by the MCP tools and the dashboard: player scoring from
 * weekly matchups, bye weeks, NFL opponents, team names and optimal lineups.
 */

import type {
  NFLGame,
  SleeperLeagueUser,
  SleeperMatchup,
  SleeperPlayer,
  SleeperRoster,
} from "./types.js";

export interface WeekScores {
  week: number;
  matchups: SleeperMatchup[];
}

// Which player positions each league roster slot can hold.
export const SLOT_POSITIONS: Record<string, string[]> = {
  QB: ["QB"],
  RB: ["RB"],
  WR: ["WR"],
  TE: ["TE"],
  K: ["K"],
  DEF: ["DEF"],
  DL: ["DL"],
  LB: ["LB"],
  DB: ["DB"],
  FLEX: ["RB", "WR", "TE"],
  WRRB_FLEX: ["WR", "RB"],
  REC_FLEX: ["WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
  IDP_FLEX: ["DL", "LB", "DB"],
};

/** Roster slots that score points (everything but bench / IR / taxi). */
export function startingSlots(rosterPositions: string[] = []): string[] {
  return rosterPositions.filter((slot) => SLOT_POSITIONS[slot]);
}

export function teamName(
  roster: Pick<SleeperRoster, "roster_id">,
  user?: SleeperLeagueUser,
): string {
  return (
    user?.metadata?.team_name ||
    user?.display_name ||
    `Team ${roster.roster_id}`
  );
}

export function playerPositions(player?: SleeperPlayer): string[] {
  if (!player) return [];
  if (player.fantasy_positions?.length) return player.fantasy_positions;
  return player.position ? [player.position] : [];
}

/** A week counts only if somebody scored, so unplayed weeks are skipped. */
export function playedWeeks(weeks: WeekScores[]): WeekScores[] {
  return weeks.filter((w) => w.matchups.some((m) => (m.points || 0) > 0));
}

export interface PlayerStat {
  total: number;
  games: number;
  ppg: number;
}

/**
 * Fantasy points per player from players_points across weeks. A week with
 * 0 points counts as no game (bye, injury, inactive) so ppg isn't dragged
 * down by missed weeks.
 */
export function playerStats(weeks: WeekScores[]): Map<string, PlayerStat> {
  const stats = new Map<string, PlayerStat>();
  for (const { matchups } of playedWeeks(weeks)) {
    for (const m of matchups) {
      for (const [id, pts] of Object.entries(m.players_points || {})) {
        const s = stats.get(id) || { total: 0, games: 0, ppg: 0 };
        s.total += pts;
        if (pts !== 0) s.games++;
        stats.set(id, s);
      }
    }
  }
  for (const s of stats.values()) {
    s.total = Math.round(s.total * 100) / 100;
    s.ppg = s.games ? Math.round((s.total / s.games) * 100) / 100 : 0;
  }
  return stats;
}

/** NFL teams with no game in the given week. */
export function byeTeams(schedule: NFLGame[], week: number): Set<string> {
  const playing = new Set<string>();
  const all = new Set<string>();
  for (const g of schedule) {
    all.add(g.home);
    all.add(g.away);
    if (g.week === week) {
      playing.add(g.home);
      playing.add(g.away);
    }
  }
  if (!playing.size) return new Set(); // no schedule for this week
  return new Set([...all].filter((t) => !playing.has(t)));
}

/** "vs KC" (home) or "@ KC" (away) for an NFL team's game that week. */
export function nflOpponent(
  schedule: NFLGame[],
  week: number,
  team?: string | null,
): string | null {
  if (!team) return null;
  const game = schedule.find(
    (g) => g.week === week && (g.home === team || g.away === team),
  );
  if (!game) return null;
  return game.home === team ? `vs ${game.away}` : `@ ${game.home}`;
}

export interface LineupSlot {
  slot: string;
  player_id: string | null;
  value: number;
}

export interface Lineup {
  total: number;
  starters: LineupSlot[];
  bench: string[];
}

/**
 * Best possible lineup by value (e.g. ppg). Restrictive slots are filled
 * first (QB before FLEX before SUPER_FLEX) so flex spots get what's left.
 */
export function optimalLineup(
  playerIds: string[],
  rosterPositions: string[],
  value: (id: string) => number,
  positionsOf: (id: string) => string[],
): Lineup {
  const slots = startingSlots(rosterPositions)
    .map((slot, index) => ({ slot, index }))
    .sort(
      (a, b) =>
        SLOT_POSITIONS[a.slot].length - SLOT_POSITIONS[b.slot].length ||
        a.index - b.index,
    );

  const used = new Set<string>();
  const filled: (LineupSlot & { index: number })[] = [];
  for (const { slot, index } of slots) {
    const eligible = SLOT_POSITIONS[slot];
    let best: string | null = null;
    for (const id of playerIds) {
      if (used.has(id)) continue;
      if (!positionsOf(id).some((p) => eligible.includes(p))) continue;
      if (best === null || value(id) > value(best)) best = id;
    }
    if (best) used.add(best);
    filled.push({
      slot,
      index,
      player_id: best,
      value: best ? value(best) : 0,
    });
  }

  filled.sort((a, b) => a.index - b.index);
  const total = filled.reduce((sum, s) => sum + s.value, 0);
  return {
    total: Math.round(total * 100) / 100,
    starters: filled.map(({ slot, player_id, value }) => ({
      slot,
      player_id,
      value,
    })),
    bench: playerIds.filter((id) => !used.has(id)),
  };
}

/** Every player ID on a roster, including IR and taxi. */
export function rosterPlayerIds(roster: SleeperRoster): string[] {
  return [
    ...new Set([
      ...(roster.players || []),
      ...(roster.reserve || []),
      ...(roster.taxi || []),
    ]),
  ];
}
