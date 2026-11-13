/**
 * Analysis built from Sleeper's weekly stat and projection feeds and
 * FantasyCalc trade values:
 *  - projections in your league's own scoring
 *  - usage trends (snap, target and carry share), to spot risers early
 *  - fantasy points allowed by each defense, per position
 *  - rest-of-season and playoff schedule strength for your players
 *  - trade values matched to Sleeper player IDs
 * All pure functions; the poller fetches and caches the inputs.
 */

import type { NFLGame, SleeperPlayer } from "../types.js";

type Stats = Record<string, number>;

/** One row from api.sleeper.app/stats|projections/nfl/{season}/{week}. */
export interface WeeklyRow {
  player_id: string;
  week: number;
  team?: string | null;
  opponent?: string | null;
  stats: Stats;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Fantasy points for a stat line under a league's scoring settings. */
export function leaguePoints(stats: Stats, scoring: Record<string, number>): number {
  let total = 0;
  for (const [key, weight] of Object.entries(scoring)) {
    const value = stats[key];
    if (value) total += value * weight;
  }
  return r2(total);
}

/** Sleeper's precomputed points key closest to a league's reception scoring. */
export function presetPointsKey(scoring: Record<string, number>): string {
  const rec = scoring.rec ?? 0;
  return rec >= 1 ? "pts_ppr" : rec > 0 ? "pts_half_ppr" : "pts_std";
}

/**
 * Projected points in league scoring. Some projections (team defenses) lack
 * the raw stats a league scores on; those fall back to Sleeper's own total for
 * the closest PPR setting.
 */
export function projectionMap(
  projections: Record<string, Stats>,
  scoring: Record<string, number>,
): Map<string, number> {
  const preset = presetPointsKey(scoring);
  const map = new Map<string, number>();
  for (const [id, stats] of Object.entries(projections)) {
    if (!stats || !stats.gp) continue;
    const pts = leaguePoints(stats, scoring);
    map.set(id, pts > 0 ? pts : r2(stats[preset] || 0));
  }
  return map;
}

// ---------- Usage trends ----------

export interface UsageWeek {
  week: number;
  snap_share: number | null;
  target_share: number | null;
  carry_share: number | null;
  opportunities: number;
  points: number;
}

export interface UsageTrend {
  player_id: string;
  name: string;
  position: string;
  team: string | null;
  recent: { snap_share: number | null; target_share: number | null; carry_share: number | null; opportunities: number; points: number };
  earlier: { snap_share: number | null; target_share: number | null; carry_share: number | null; opportunities: number; points: number };
  change: { snap_share: number | null; opportunities: number; points: number };
  weeks: UsageWeek[];
  reason: string;
}

const SKILL = new Set(["RB", "WR", "TE"]);

function avg(values: (number | null)[]): number | null {
  const real = values.filter((v): v is number => v != null);
  return real.length ? real.reduce((a, b) => a + b, 0) / real.length : null;
}

/**
 * Per-player usage by week, then the last `recentWeeks` games compared with
 * the games before them. Players need at least two earlier games so a
 * one-week cameo isn't a "trend".
 */
export function usageTrends(
  rows: WeeklyRow[],
  players: Map<string, SleeperPlayer>,
  scoring: Record<string, number>,
  options: { recentWeeks?: number } = {},
): UsageTrend[] {
  const recentWeeks = options.recentWeeks ?? 2;
  // team totals per week
  const teamTotals = new Map<string, { tgt: number; car: number }>();
  for (const r of rows) {
    if (!r.team || !r.stats) continue;
    const key = `${r.team}:${r.week}`;
    const t = teamTotals.get(key) || { tgt: 0, car: 0 };
    t.tgt += r.stats.rec_tgt || 0;
    t.car += r.stats.rush_att || 0;
    teamTotals.set(key, t);
  }

  const byPlayer = new Map<string, UsageWeek[]>();
  for (const r of rows) {
    const p = players.get(r.player_id);
    if (!p || !SKILL.has(p.position) || !r.stats?.gms_active) continue;
    const s = r.stats;
    const totals = r.team ? teamTotals.get(`${r.team}:${r.week}`) : undefined;
    const week: UsageWeek = {
      week: r.week,
      snap_share: s.tm_off_snp ? r3((s.off_snp || 0) / s.tm_off_snp) : null,
      target_share: totals?.tgt ? r3((s.rec_tgt || 0) / totals.tgt) : null,
      carry_share: totals?.car ? r3((s.rush_att || 0) / totals.car) : null,
      opportunities: (s.rec_tgt || 0) + (s.rush_att || 0),
      points: leaguePoints(s, scoring),
    };
    byPlayer.set(r.player_id, [...(byPlayer.get(r.player_id) || []), week]);
  }

  const out: UsageTrend[] = [];
  for (const [id, weeksRaw] of byPlayer) {
    const weeks = weeksRaw.sort((a, b) => a.week - b.week);
    if (weeks.length < recentWeeks + 2) continue;
    const recent = weeks.slice(-recentWeeks);
    const earlier = weeks.slice(0, -recentWeeks);
    const sum = (ws: UsageWeek[]) => ({
      snap_share: avg(ws.map((w) => w.snap_share)),
      target_share: avg(ws.map((w) => w.target_share)),
      carry_share: avg(ws.map((w) => w.carry_share)),
      opportunities: avg(ws.map((w) => w.opportunities)) || 0,
      points: avg(ws.map((w) => w.points)) || 0,
    });
    const a = sum(recent);
    const b = sum(earlier);
    const p = players.get(id)!;
    const snapChange =
      a.snap_share != null && b.snap_share != null ? a.snap_share - b.snap_share : null;
    const reasons: string[] = [];
    if (snapChange != null && Math.abs(snapChange) >= 0.08) {
      reasons.push(
        `snaps ${Math.round((b.snap_share || 0) * 100)}% → ${Math.round((a.snap_share || 0) * 100)}%`,
      );
    }
    const oppChange = a.opportunities - b.opportunities;
    if (Math.abs(oppChange) >= 2) {
      reasons.push(`touches+targets ${r1(b.opportunities)} → ${r1(a.opportunities)} a game`);
    }
    const round = (x: typeof a) => ({
      snap_share: x.snap_share == null ? null : r3(x.snap_share),
      target_share: x.target_share == null ? null : r3(x.target_share),
      carry_share: x.carry_share == null ? null : r3(x.carry_share),
      opportunities: r1(x.opportunities),
      points: r1(x.points),
    });
    out.push({
      player_id: id,
      name: `${p.first_name} ${p.last_name}`.trim(),
      position: p.position,
      team: p.team || null,
      recent: round(a),
      earlier: round(b),
      change: {
        snap_share: snapChange == null ? null : r3(snapChange),
        opportunities: r1(oppChange),
        points: r1(a.points - b.points),
      },
      weeks,
      reason: reasons.join("; "),
    });
  }
  return out;
}

/**
 * Risers: growing role, not just one big box score. Score = change in
 * opportunities a game plus snap-share change (in points of 10%).
 */
export function riserScore(t: UsageTrend): number {
  return t.change.opportunities + (t.change.snap_share ?? 0) * 20;
}

// ---------- Defense vs position and schedule strength ----------

export const SOS_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"] as const;

/**
 * Average fantasy points (league scoring) each defense allows per game to each
 * position, summing all players at that position in a game. Rank 1 = allows
 * the most = easiest matchup.
 */
export function pointsAllowed(
  rows: WeeklyRow[],
  players: Map<string, SleeperPlayer>,
  scoring: Record<string, number>,
): Map<string, Map<string, { per_game: number; rank: number }>> {
  const games = new Map<string, number>(); // `${def}:${pos}:${week}` → pts
  for (const r of rows) {
    if (!r.opponent || !r.stats?.gms_active) continue;
    const pos = players.get(r.player_id)?.position;
    if (!pos || !(SOS_POSITIONS as readonly string[]).includes(pos)) continue;
    const key = `${r.opponent}:${pos}:${r.week}`;
    games.set(key, (games.get(key) || 0) + leaguePoints(r.stats, scoring));
  }
  const totals = new Map<string, Map<string, { sum: number; n: number }>>();
  for (const [key, pts] of games) {
    const [def, pos] = key.split(":");
    const byPos = totals.get(pos) || new Map();
    const t = byPos.get(def) || { sum: 0, n: 0 };
    t.sum += pts;
    t.n += 1;
    byPos.set(def, t);
    totals.set(pos, byPos);
  }
  const result = new Map<string, Map<string, { per_game: number; rank: number }>>();
  for (const [pos, byDef] of totals) {
    const ranked = [...byDef.entries()]
      .map(([def, t]) => [def, t.sum / t.n] as const)
      .sort((a, b) => b[1] - a[1]);
    result.set(
      pos,
      new Map(ranked.map(([def, pg], i) => [def, { per_game: r1(pg), rank: i + 1 }])),
    );
  }
  return result;
}

export interface ScheduleWeek {
  week: number;
  opponent: string | null;
  home: boolean;
  rank: number | null;
  allowed: number | null;
  playoffs: boolean;
}

export interface PlayerOutlook {
  player_id: string;
  name: string;
  position: string;
  team: string | null;
  weeks: ScheduleWeek[];
  /** Average opponent rank (1 = easiest of 32) over the weeks listed. */
  ros_rank: number | null;
  playoff_rank: number | null;
  grade: "easy" | "neutral" | "hard" | null;
}

export function scheduleOutlook(input: {
  playerIds: string[];
  players: Map<string, SleeperPlayer>;
  schedule: NFLGame[];
  allowed: ReturnType<typeof pointsAllowed>;
  fromWeek: number;
  throughWeek: number;
  playoffStart: number;
}): PlayerOutlook[] {
  const { players, schedule, allowed } = input;
  return input.playerIds.flatMap((id) => {
    const p = players.get(id);
    if (!p || !(SOS_POSITIONS as readonly string[]).includes(p.position)) return [];
    const team = p.team || null;
    const weeks: ScheduleWeek[] = [];
    for (let w = input.fromWeek; w <= input.throughWeek; w++) {
      const game = team
        ? schedule.find((g) => g.week === w && (g.home === team || g.away === team))
        : undefined;
      const opponent = game ? (game.home === team ? game.away : game.home) : null;
      const a = opponent ? allowed.get(p.position)?.get(opponent) : undefined;
      weeks.push({
        week: w,
        opponent,
        home: !!game && game.home === team,
        rank: a?.rank ?? null,
        allowed: a?.per_game ?? null,
        playoffs: w >= input.playoffStart,
      });
    }
    const rosRank = avg(weeks.map((w) => w.rank));
    const poRank = avg(weeks.filter((w) => w.playoffs).map((w) => w.rank));
    return [
      {
        player_id: id,
        name: `${p.first_name} ${p.last_name}`.trim(),
        position: p.position,
        team,
        weeks,
        ros_rank: rosRank == null ? null : r1(rosRank),
        playoff_rank: poRank == null ? null : r1(poRank),
        grade:
          rosRank == null ? null : rosRank <= 12 ? "easy" : rosRank >= 21 ? "hard" : "neutral",
      },
    ];
  });
}

// ---------- Trade values (FantasyCalc) ----------

export interface FantasyCalcRow {
  value: number;
  overallRank: number;
  positionRank: number;
  trend30Day?: number;
  player: { sleeperId?: string | null; name: string; position: string; maybeTeam?: string | null };
}

export interface TradeValue {
  value: number;
  overall_rank: number;
  position_rank: number;
  trend_30d: number;
}

export function tradeValues(rows: FantasyCalcRow[]): Map<string, TradeValue> {
  const map = new Map<string, TradeValue>();
  for (const r of rows) {
    if (!r.player?.sleeperId) continue;
    map.set(String(r.player.sleeperId), {
      value: r.value,
      overall_rank: r.overallRank,
      position_rank: r.positionRank,
      trend_30d: r.trend30Day ?? 0,
    });
  }
  return map;
}

/** FantasyCalc query parameters that match a Sleeper league's format. */
export function fantasyCalcParams(league: {
  roster_positions: string[];
  scoring_settings: Record<string, number>;
  settings: { type?: number };
  total_rosters?: number;
}, teams: number): string {
  const qbs = league.roster_positions.includes("SUPER_FLEX") ||
    league.roster_positions.filter((s) => s === "QB").length > 1 ? 2 : 1;
  const ppr = league.scoring_settings.rec ?? 0;
  const dynasty = league.settings.type === 2;
  return new URLSearchParams({
    isDynasty: String(dynasty),
    numQbs: String(qbs),
    numTeams: String(teams),
    ppr: String(ppr),
  }).toString();
}
