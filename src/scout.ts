import {
  byeTeams,
  nflOpponent,
  playerPositions,
  playerStats,
  startingSlots,
  teamName,
  type WeekScores,
} from "./season.js";
import type {
  NFLGame,
  SleeperLeagueUser,
  SleeperMatchup,
  SleeperPlayer,
  SleeperRoster,
  SleeperTransaction,
} from "./types.js";

const RISKY_INJURY = new Set(["Out", "IR", "Doubtful", "Suspended", "PUP"]);

export interface ScoutInput {
  myRosterId: number;
  week: number;
  /** This week's matchups (live scores). */
  currentMatchups: SleeperMatchup[];
  /** Completed weeks, for season averages. */
  weeks: WeekScores[];
  rosters: SleeperRoster[];
  users: SleeperLeagueUser[];
  players: Map<string, SleeperPlayer>;
  rosterPositions: string[];
  schedule: NFLGame[];
  /** Recent league transactions (any weeks). */
  transactions: SleeperTransaction[];
}

export interface ScoutedPlayer {
  slot: string;
  player_id: string | null;
  name: string;
  position: string | null;
  team: string | null;
  nfl_opponent: string | null;
  injury_status: string | null;
  on_bye: boolean;
  points_this_week: number;
  season_ppg: number | null;
  flags: string[];
}

export interface WeakSpot {
  slot: string;
  their_avg: number;
  league_avg: number;
  diff: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function playerName(p?: SleeperPlayer, id?: string | null): string {
  if (!p) return id || "Empty";
  return `${p.first_name || ""} ${p.last_name || ""}`.trim() || id || "?";
}

/**
 * Season average points per starting slot, from starters_points (which is
 * ordered like the league's starting slots).
 */
export function slotAverages(
  weeks: WeekScores[],
  slotCount: number,
): {
  byRoster: Map<number, number[]>;
  league: number[];
} {
  const sums = new Map<number, { totals: number[]; games: number }>();
  for (const { matchups } of weeks) {
    for (const m of matchups) {
      const pts = m.starters_points || [];
      if (!pts.length) continue;
      const s = sums.get(m.roster_id) || {
        totals: new Array(slotCount).fill(0),
        games: 0,
      };
      for (let i = 0; i < slotCount; i++) s.totals[i] += pts[i] || 0;
      s.games++;
      sums.set(m.roster_id, s);
    }
  }
  const byRoster = new Map<number, number[]>();
  for (const [id, s] of sums) {
    byRoster.set(
      id,
      s.totals.map((t) => r2(t / s.games)),
    );
  }
  const league = new Array(slotCount).fill(0).map((_, i) => {
    const vals = [...byRoster.values()].map((a) => a[i]);
    return vals.length ? r2(vals.reduce((x, y) => x + y, 0) / vals.length) : 0;
  });
  return { byRoster, league };
}

export function scoutOpponent(input: ScoutInput) {
  const {
    myRosterId,
    week,
    currentMatchups,
    weeks,
    rosters,
    users,
    players,
    rosterPositions,
    schedule,
    transactions,
  } = input;

  const mine = currentMatchups.find((m) => m.roster_id === myRosterId);
  if (!mine || mine.matchup_id == null) {
    return { has_opponent: false as const, week };
  }
  const theirs = currentMatchups.find(
    (m) => m.matchup_id === mine.matchup_id && m.roster_id !== myRosterId,
  );
  if (!theirs) return { has_opponent: false as const, week };

  const userMap = new Map(users.map((u) => [u.user_id, u]));
  const oppRoster = rosters.find((r) => r.roster_id === theirs.roster_id);
  const oppUser = oppRoster ? userMap.get(oppRoster.owner_id) : undefined;
  const slots = startingSlots(rosterPositions);
  const stats = playerStats(weeks);
  const byes = byeTeams(schedule, week);

  const lineup: ScoutedPlayer[] = slots.map((slot, i) => {
    const raw = theirs.starters?.[i];
    const id = raw && raw !== "0" ? raw : null;
    const p = id ? players.get(id) : undefined;
    const team = p?.team || null;
    const onBye = !!team && byes.has(team);
    const injury = p?.injury_status || null;
    const flags: string[] = [];
    if (!id) flags.push("EMPTY SLOT");
    if (onBye) flags.push("ON BYE");
    if (injury && RISKY_INJURY.has(injury)) flags.push(injury.toUpperCase());
    else if (injury) flags.push(injury);
    return {
      slot,
      player_id: id,
      name: id ? playerName(p, id) : "Empty",
      position: p?.position || null,
      team,
      nfl_opponent: nflOpponent(schedule, week, team),
      injury_status: injury,
      on_bye: onBye,
      points_this_week: r2(theirs.starters_points?.[i] || 0),
      season_ppg: id ? (stats.get(id)?.ppg ?? null) : null,
      flags,
    };
  });

  // Weak spots: slots where their season average trails the league's
  const { byRoster, league } = slotAverages(weeks, slots.length);
  const theirAvg = byRoster.get(theirs.roster_id) || [];
  const weakSpots: WeakSpot[] = slots
    .map((slot, i) => ({
      slot,
      their_avg: theirAvg[i] ?? 0,
      league_avg: league[i] ?? 0,
      diff: r2((theirAvg[i] ?? 0) - (league[i] ?? 0)),
    }))
    .filter((w) => theirAvg.length && w.diff < 0)
    .sort((a, b) => a.diff - b.diff)
    .slice(0, 3);
  const strengths = slots
    .map((slot, i) => ({
      slot,
      their_avg: theirAvg[i] ?? 0,
      league_avg: league[i] ?? 0,
      diff: r2((theirAvg[i] ?? 0) - (league[i] ?? 0)),
    }))
    .filter((w) => theirAvg.length && w.diff > 0)
    .sort((a, b) => b.diff - a.diff)
    .slice(0, 3);

  // Bench depth by position
  const starterIds = new Set(lineup.map((p) => p.player_id).filter(Boolean));
  const bench = (theirs.players || oppRoster?.players || [])
    .filter((id) => !starterIds.has(id))
    .map((id) => {
      const p = players.get(id);
      return {
        player_id: id,
        name: playerName(p, id),
        position: p?.position || playerPositions(p)[0] || null,
        team: p?.team || null,
        injury_status: p?.injury_status || null,
        season_ppg: stats.get(id)?.ppg ?? null,
      };
    })
    .sort((a, b) => (b.season_ppg ?? 0) - (a.season_ppg ?? 0));

  // Their recent moves
  const recentMoves = transactions
    .filter(
      (t) =>
        t.status === "complete" && t.roster_ids?.includes(theirs.roster_id),
    )
    .sort((a, b) => b.created - a.created)
    .slice(0, 8)
    .map((t) => ({
      type: t.type,
      week: t.leg,
      date: new Date(t.created).toISOString().slice(0, 10),
      added: Object.entries(t.adds || {})
        .filter(([, rid]) => rid === theirs.roster_id)
        .map(([id]) => playerName(players.get(id), id)),
      dropped: Object.entries(t.drops || {})
        .filter(([, rid]) => rid === theirs.roster_id)
        .map(([id]) => playerName(players.get(id), id)),
      faab_bid: t.settings?.waiver_bid ?? null,
    }));

  const s = oppRoster?.settings;
  const lineupProblems = lineup.filter(
    (p) =>
      !p.player_id ||
      p.on_bye ||
      (p.injury_status && RISKY_INJURY.has(p.injury_status)),
  );

  return {
    has_opponent: true as const,
    week,
    opponent: {
      roster_id: theirs.roster_id,
      team_name: oppRoster ? teamName(oppRoster, oppUser) : "Unknown",
      owner: oppUser?.display_name || "Unknown",
      record: s ? `${s.wins}-${s.losses}${s.ties ? `-${s.ties}` : ""}` : null,
      points_for: s ? r2(s.fpts + (s.fpts_decimal || 0) / 100) : null,
    },
    score: {
      you: r2(mine.points || 0),
      them: r2(theirs.points || 0),
    },
    their_lineup: lineup,
    lineup_problems: lineupProblems.map(
      (p) => `${p.slot}: ${p.name} (${p.flags.join(", ")})`,
    ),
    weak_spots: weakSpots,
    strengths,
    bench,
    recent_moves: recentMoves,
  };
}
