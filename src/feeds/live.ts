/**
 * Live game tracking: ESPN's public scoreboard for game state (clock,
 * possession, red zone, last play) plus Sleeper's league matchup for points
 * in your league's scoring. Pure functions; the poller does the fetching.
 */

import type { SleeperMatchup, SleeperPlayer } from "../types.js";

export type GameState = "pre" | "in" | "post";

export interface LiveGame {
  id: string;
  state: GameState;
  detail: string;
  start: string;
  period: number;
  clock_seconds: number;
  home: { team: string; score: number };
  away: { team: string; score: number };
  possession: string | null;
  red_zone: boolean;
  down_distance: string | null;
  last_play: string | null;
  /** Share of regulation still to play: 1 before kickoff, 0 when final. */
  fraction_left: number;
}

/** ESPN and Sleeper disagree on one team code. */
const ESPN_TO_SLEEPER: Record<string, string> = { WSH: "WAS" };
export const toSleeperTeam = (abbr: string) => ESPN_TO_SLEEPER[abbr] || abbr;

export function fractionLeft(
  state: GameState,
  period: number,
  clockSeconds: number,
): number {
  if (state === "pre") return 1;
  if (state === "post") return 0;
  if (period > 4) return 0.02; // overtime: almost nothing left
  const left = (4 - period) * 900 + Math.max(0, Math.min(900, clockSeconds));
  return Math.max(0, Math.min(1, left / 3600));
}

interface EspnCompetitor {
  homeAway: "home" | "away";
  score?: string;
  team: { id: string; abbreviation: string };
}

interface EspnEvent {
  id: string;
  date: string;
  status: {
    clock?: number;
    period?: number;
    type: { state: string; shortDetail?: string; detail?: string };
  };
  competitions: {
    competitors: EspnCompetitor[];
    situation?: {
      possession?: string;
      isRedZone?: boolean;
      downDistanceText?: string;
      lastPlay?: { text?: string };
    };
  }[];
}

export function parseScoreboard(json: { events?: EspnEvent[] }): LiveGame[] {
  return (json.events || []).flatMap((e) => {
    const comp = e.competitions?.[0];
    if (!comp) return [];
    const home = comp.competitors.find((c) => c.homeAway === "home");
    const away = comp.competitors.find((c) => c.homeAway === "away");
    if (!home || !away) return [];
    const raw = e.status.type.state;
    const state: GameState = raw === "in" ? "in" : raw === "post" ? "post" : "pre";
    const period = e.status.period || 0;
    const clock = e.status.clock || 0;
    const sit = comp.situation;
    const possessionTeam = sit?.possession
      ? [home, away].find((c) => c.team.id === sit.possession)
      : undefined;
    return [
      {
        id: e.id,
        state,
        detail: e.status.type.shortDetail || e.status.type.detail || "",
        start: e.date,
        period,
        clock_seconds: clock,
        home: {
          team: toSleeperTeam(home.team.abbreviation),
          score: Number(home.score) || 0,
        },
        away: {
          team: toSleeperTeam(away.team.abbreviation),
          score: Number(away.score) || 0,
        },
        possession: possessionTeam
          ? toSleeperTeam(possessionTeam.team.abbreviation)
          : null,
        red_zone: state === "in" && !!sit?.isRedZone,
        down_distance: state === "in" ? sit?.downDistanceText || null : null,
        last_play: state === "in" ? sit?.lastPlay?.text?.trim() || null : null,
        fraction_left: fractionLeft(state, period, clock),
      },
    ];
  });
}

export function gamesByTeam(games: LiveGame[]): Map<string, LiveGame> {
  const map = new Map<string, LiveGame>();
  for (const g of games) {
    map.set(g.home.team, g);
    map.set(g.away.team, g);
  }
  return map;
}

/** True when any of these players' NFL teams is in a game right now. */
export function anyPlaying(
  playerIds: Iterable<string>,
  players: Map<string, SleeperPlayer>,
  byTeam: Map<string, LiveGame>,
): boolean {
  for (const id of playerIds) {
    const team = players.get(id)?.team;
    if (team && byTeam.get(team)?.state === "in") return true;
  }
  return false;
}

type Stats = Record<string, number>;

/** Short stat line, e.g. "18/27 241 yd 2 TD" or "6 rec (8 tgt) 74 yd". */
export function statLine(stats: Stats | undefined, position?: string | null): string {
  if (!stats) return "";
  const n = (k: string) => stats[k] || 0;
  const parts: string[] = [];
  if (position === "DEF") {
    if (n("sack")) parts.push(`${n("sack")} sack`);
    if (n("int")) parts.push(`${n("int")} INT`);
    if (n("fum_rec")) parts.push(`${n("fum_rec")} FR`);
    if (n("def_td")) parts.push(`${n("def_td")} TD`);
    if (stats.pts_allow != null) parts.push(`${n("pts_allow")} pts allowed`);
    return parts.join(" · ");
  }
  if (position === "K") {
    if (n("fga")) parts.push(`${n("fgm")}/${n("fga")} FG`);
    if (n("xpa") || n("xpm")) parts.push(`${n("xpm")} XP`);
    return parts.join(" · ");
  }
  if (n("pass_att")) {
    parts.push(
      `${n("pass_cmp")}/${n("pass_att")} ${n("pass_yd")} yd` +
        (n("pass_td") ? ` ${n("pass_td")} TD` : "") +
        (n("pass_int") ? ` ${n("pass_int")} INT` : ""),
    );
  }
  if (n("rush_att")) {
    parts.push(
      `${n("rush_att")} car ${n("rush_yd")} yd` +
        (n("rush_td") ? ` ${n("rush_td")} TD` : ""),
    );
  }
  if (n("rec_tgt") || n("rec")) {
    parts.push(
      `${n("rec")} rec (${n("rec_tgt")} tgt) ${n("rec_yd")} yd` +
        (n("rec_td") ? ` ${n("rec_td")} TD` : ""),
    );
  }
  if (n("fum_lost")) parts.push(`${n("fum_lost")} fum lost`);
  return parts.join(" · ");
}

export type Pace = "good" | "bad" | "even" | null;

/**
 * Points vs the share of the projection that "should" be in by now. Early in
 * a game (under 10% played) everything reads even; a final compares to the
 * full projection.
 */
export function paceOf(
  points: number,
  projected: number | null,
  state: GameState | "bye",
  fractionLeft: number,
): Pace {
  if (projected == null || projected <= 0 || state === "pre" || state === "bye") return null;
  const played = state === "post" ? 1 : 1 - fractionLeft;
  if (played < 0.1) return points > 0 ? "good" : "even";
  const expected = projected * played;
  if (points >= expected * 1.1 && points - expected >= 1) return "good";
  if (points <= expected * 0.7 && expected - points >= 1) return "bad";
  return "even";
}

export interface LivePlayer {
  player_id: string;
  name: string;
  position: string | null;
  team: string | null;
  slot: string;
  points: number;
  projected: number | null;
  projected_final: number;
  /**
   * How he's doing against his projection so far, like Sleeper's green/red:
   * "good" ahead of pace, "bad" well behind, "even" in between, null before
   * kickoff or without a projection.
   */
  pace: Pace;
  stat_line: string;
  game: {
    state: GameState | "bye";
    detail: string;
    start: string | null;
    opponent: string | null;
    has_ball: boolean;
    red_zone: boolean;
  };
}

export interface LiveSide {
  roster_id: number;
  team_name: string;
  points: number;
  projected_final: number;
  /** Team pace: points so far vs projection for the game time played. */
  pace: Pace;
  playing_now: number;
  yet_to_play: number;
  starters: LivePlayer[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function liveSide(input: {
  matchup: SleeperMatchup;
  teamName: string;
  slots: string[];
  players: Map<string, SleeperPlayer>;
  byTeam: Map<string, LiveGame>;
  projections: Map<string, number>;
  stats: Record<string, Stats>;
}): LiveSide {
  const { matchup, players, byTeam, projections, stats } = input;
  const starters = (matchup.starters || []).map((id, i): LivePlayer | null => {
    if (!id || id === "0") return null;
    const p = players.get(id);
    const team = p?.team || null;
    const game = team ? byTeam.get(team) : undefined;
    const points = matchup.players_points?.[id] ?? 0;
    const projected = projections.has(id) ? projections.get(id)! : null;
    const left = game ? game.fraction_left : 0;
    return {
      player_id: id,
      name: p ? `${p.first_name} ${p.last_name}`.trim() : id,
      position: p?.position || null,
      team,
      slot: input.slots[i] || "FLEX",
      points: r2(points),
      projected: projected == null ? null : r2(projected),
      projected_final: r2(points + (projected ?? 0) * left),
      pace: paceOf(points, projected, game ? game.state : "bye", left),
      stat_line: statLine(stats[id], p?.position),
      game: game
        ? {
            state: game.state,
            detail: game.detail,
            start: game.start,
            opponent:
              game.home.team === team
                ? `vs ${game.away.team}`
                : `@ ${game.home.team}`,
            has_ball: game.state === "in" && game.possession === team,
            red_zone: game.state === "in" && game.red_zone && game.possession === team,
          }
        : { state: "bye", detail: "No game", start: null, opponent: null, has_ball: false, red_zone: false },
    };
  });
  const list = starters.filter((s): s is LivePlayer => !!s);
  return {
    roster_id: matchup.roster_id,
    team_name: input.teamName,
    points: r2(matchup.points || 0),
    projected_final: r2(list.reduce((sum, s) => sum + s.projected_final, 0)),
    pace: teamPace(list, byTeam),
    playing_now: list.filter((s) => s.game.state === "in").length,
    yet_to_play: list.filter((s) => s.game.state === "pre").length,
    starters: list,
  };
}

function teamPace(list: LivePlayer[], byTeam: Map<string, LiveGame>): Pace {
  let points = 0;
  let expected = 0;
  for (const p of list) {
    if (p.projected == null || p.game.state === "pre" || p.game.state === "bye") continue;
    const g = p.team ? byTeam.get(p.team) : undefined;
    const played = p.game.state === "post" ? 1 : 1 - (g?.fraction_left ?? 1);
    points += p.points;
    expected += p.projected * played;
  }
  if (expected < 3) return null;
  if (points >= expected * 1.1) return "good";
  if (points <= expected * 0.85) return "bad";
  return "even";
}

/** Standard normal CDF (Abramowitz-Stegun approximation). */
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p =
    d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

/**
 * Rough win chance from projected finals. Each player's remaining projection
 * is treated as uncertain (standard deviation about 60% of what's left), so a
 * lead with nothing left to play is near-certain and an early lead is not.
 */
export function winProbability(me: LiveSide, opp: LiveSide): number {
  const remaining = (s: LiveSide) =>
    s.starters.map((p) => Math.max(0, p.projected_final - p.points));
  const variance = [...remaining(me), ...remaining(opp)].reduce(
    (v, r) => v + (0.6 * r) ** 2 + (r > 0 ? 4 : 0),
    0,
  );
  const diff = me.projected_final - opp.projected_final;
  if (variance === 0) return diff > 0 ? 1 : diff < 0 ? 0 : 0.5;
  return Math.round(normalCdf(diff / Math.sqrt(variance)) * 1000) / 1000;
}

export interface ScoreEvent {
  at: string;
  player_id: string;
  name: string;
  side: "mine" | "opponent";
  delta: number;
  total: number;
}

/** Point changes between two polls, for the live ticker. */
export function scoreEvents(
  before: LiveSide | null,
  after: LiveSide,
  side: ScoreEvent["side"],
  at = new Date().toISOString(),
): ScoreEvent[] {
  if (!before) return [];
  const prev = new Map(before.starters.map((p) => [p.player_id, p.points]));
  return after.starters.flatMap((p) => {
    const old = prev.get(p.player_id);
    if (old == null) return [];
    const delta = r2(p.points - old);
    return Math.abs(delta) >= 0.05
      ? [{ at, player_id: p.player_id, name: p.name, side, delta, total: p.points }]
      : [];
  });
}
