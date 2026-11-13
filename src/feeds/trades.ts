/**
 * Trades: position strength for every team, trade suggestions that help both
 * sides, and an evaluation of any trade (suggested, entered by hand, or
 * completed in the league).
 *
 * A trade is judged two ways:
 *  - Lineup impact: each team's best lineup for every remaining week through
 *    the fantasy playoffs, from Sleeper's projections, before and after. That
 *    counts byes, injuries and positional need.
 *  - Market value: FantasyCalc values (in league format), with the side that
 *    gets more players discounted for depth (2 decent players are worth less
 *    than their sum to a team that can only start one).
 * Suggestions must improve both lineups and keep the value close, so the
 * other manager has a real reason to accept.
 */

import { optimalLineup, playerPositions, startingSlots } from "../season.js";
import type { SleeperPlayer } from "../types.js";

const r1 = (n: number) => Math.round(n * 10) / 10;
const TRADEABLE = new Set(["QB", "RB", "WR", "TE"]);

export interface TradeContext {
  rosterPositions: string[];
  fromWeek: number;
  throughWeek: number;
  playoffStart: number;
  projections: Map<number, Map<string, number>>;
  players: Map<string, SleeperPlayer>;
  values: Map<string, number>;
}

/** Rest-of-season and playoff starting points for a set of players. */
export function lineupPoints(ids: string[], ctx: TradeContext): { ros: number; playoffs: number } {
  let ros = 0;
  let playoffs = 0;
  const positions = (id: string) => playerPositions(ctx.players.get(id));
  for (let w = ctx.fromWeek; w <= ctx.throughWeek; w++) {
    const proj = ctx.projections.get(w);
    const t = optimalLineup(ids, ctx.rosterPositions, (id) => proj?.get(id) ?? 0, positions).total;
    ros += t;
    if (w >= ctx.playoffStart) playoffs += t;
  }
  return { ros, playoffs };
}

/** Package value with a depth discount: best player 100%, then 60%, 40%, 30%. */
export function packageValue(ids: string[], values: Map<string, number>): number {
  const weights = [1, 0.6, 0.4, 0.3];
  return Math.round(
    ids
      .map((id) => values.get(id) || 0)
      .sort((a, b) => b - a)
      .reduce((s, v, i) => s + v * (weights[i] ?? 0.25), 0),
  );
}

// ---------- position strength ----------

const SLOT_GROUP: Record<string, string> = {
  QB: "QB", RB: "RB", WR: "WR", TE: "TE", K: "K", DEF: "DEF",
  FLEX: "FLEX", WRRB_FLEX: "FLEX", REC_FLEX: "FLEX", SUPER_FLEX: "SFLEX",
};

export interface Strength {
  group: string;
  ppg: number;
  diff: number;
  rank: number;
}

/**
 * Points a week each team got from each starting position this season, vs
 * the league average, with a rank (1 = best).
 */
export function positionStrength(
  weeks: { matchups: { roster_id: number; starters_points?: number[] }[] }[],
  rosterPositions: string[],
): Map<number, Map<string, Strength>> {
  const slots = startingSlots(rosterPositions);
  const totals = new Map<number, Record<string, number>>();
  for (const w of weeks) {
    for (const m of w.matchups) {
      const t = totals.get(m.roster_id) || {};
      (m.starters_points || []).forEach((pts, i) => {
        const g = SLOT_GROUP[slots[i]];
        if (g) t[g] = (t[g] || 0) + (pts || 0);
      });
      totals.set(m.roster_id, t);
    }
  }
  const n = Math.max(1, weeks.length);
  const groups = [...new Set(slots.map((s) => SLOT_GROUP[s]).filter(Boolean))];
  const out = new Map<number, Map<string, Strength>>();
  for (const g of groups) {
    const rows = [...totals.entries()].map(([rid, t]) => ({ rid, ppg: (t[g] || 0) / n }));
    const avg = rows.reduce((s, r) => s + r.ppg, 0) / Math.max(1, rows.length);
    rows.sort((a, b) => b.ppg - a.ppg);
    rows.forEach((r, i) => {
      const m = out.get(r.rid) || new Map<string, Strength>();
      m.set(g, { group: g, ppg: r1(r.ppg), diff: r1(r.ppg - avg), rank: i + 1 });
      out.set(r.rid, m);
    });
  }
  return out;
}

// ---------- evaluating one trade ----------

export interface TradeSide {
  roster_id: number;
  gives: string[];
  gets: string[];
  ros_before: number;
  ros_after: number;
  ros_gain: number;
  playoff_gain: number;
  value_gives: number;
  value_gets: number;
}

export interface TradeEval {
  a: TradeSide;
  b: TradeSide;
  /** Value b receives ÷ value b gives (1 = even; below 1 favors a). */
  value_ratio_b: number;
  acceptance: "likely" | "possible" | "long shot";
  verdict_a: "win" | "fair" | "lose";
}

export function evaluateTrade(
  ctx: TradeContext,
  a: { roster_id: number; ids: string[] },
  b: { roster_id: number; ids: string[] },
  aGives: string[],
  bGives: string[],
): TradeEval {
  const aAfter = [...a.ids.filter((id) => !aGives.includes(id)), ...bGives];
  const bAfter = [...b.ids.filter((id) => !bGives.includes(id)), ...aGives];
  const side = (rid: number, before: string[], after: string[], gives: string[], gets: string[]): TradeSide => {
    const x = lineupPoints(before, ctx);
    const y = lineupPoints(after, ctx);
    return {
      roster_id: rid,
      gives,
      gets,
      ros_before: r1(x.ros),
      ros_after: r1(y.ros),
      ros_gain: r1(y.ros - x.ros),
      playoff_gain: r1(y.playoffs - x.playoffs),
      value_gives: packageValue(gives, ctx.values),
      value_gets: packageValue(gets, ctx.values),
    };
  };
  const sa = side(a.roster_id, a.ids, aAfter, aGives, bGives);
  const sb = side(b.roster_id, b.ids, bAfter, bGives, aGives);
  const ratio = sb.value_gives ? sb.value_gets / sb.value_gives : sb.value_gets ? 2 : 1;
  const acceptance: TradeEval["acceptance"] =
    sb.ros_gain >= 4 && ratio >= 0.97 ? "likely" : sb.ros_gain >= 1 && ratio >= 0.9 ? "possible" : "long shot";
  const aRatio = sa.value_gives ? sa.value_gets / sa.value_gives : 1;
  const verdict_a: TradeEval["verdict_a"] =
    sa.ros_gain >= 2 && aRatio >= 0.9 ? "win" : sa.ros_gain <= -2 || aRatio < 0.8 ? "lose" : "fair";
  return { a: sa, b: sb, value_ratio_b: Math.round(ratio * 100) / 100, acceptance, verdict_a };
}

// ---------- suggestions ----------

export interface TradeIdea extends TradeEval {
  partner_roster_id: number;
  score: number;
  reasons: string[];
}

function combos<T>(xs: T[], k: number): T[][] {
  if (k === 1) return xs.map((x) => [x]);
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) out.push([xs[i], xs[j]]);
  return out;
}

export function suggestTrades(
  ctx: TradeContext,
  me: { roster_id: number; ids: string[] },
  others: { roster_id: number; ids: string[] }[],
  strength: Map<number, Map<string, Strength>>,
  options: {
    pool?: number;
    perPartner?: number;
    limit?: number;
    minGainMe?: number;
    /** Team names for the reasons text (a = you, b = partner). */
    names?: (partnerId: number) => { a: string; b: string };
  } = {},
): TradeIdea[] {
  const pool = options.pool ?? 10;
  const minMe = options.minGainMe ?? 3;
  const pick = (ids: string[]) =>
    ids
      .filter((id) => TRADEABLE.has(ctx.players.get(id)?.position || "") && (ctx.values.get(id) || 0) > 0)
      .sort((x, y) => (ctx.values.get(y) || 0) - (ctx.values.get(x) || 0))
      .slice(0, pool);
  const mine = pick(me.ids);
  const ideas: TradeIdea[] = [];
  for (const other of others) {
    const theirs = pick(other.ids);
    const shapes: [number, number][] = [[1, 1], [2, 1], [1, 2]];
    const found: TradeIdea[] = [];
    for (const [give, get] of shapes) {
      for (const g of combos(mine, give)) {
        for (const t of combos(theirs, get)) {
          const e = evaluateTrade(ctx, me, other, g, t);
          if (e.a.ros_gain < minMe || e.b.ros_gain < 1) continue;
          // the fantasy playoffs are what matter most to both managers
          if (e.a.playoff_gain < 0 || e.b.playoff_gain < -0.5) continue;
          // fair enough to be accepted, not a fleece either way
          if (e.value_ratio_b < 0.9 || e.value_ratio_b > 1.35) continue;
          if (e.acceptance === "long shot") continue;
          const score = Math.min(e.a.ros_gain, e.b.ros_gain * 1.5) + 0.25 * e.a.ros_gain + (e.acceptance === "likely" ? 2 : 0);
          found.push({ ...e, partner_roster_id: other.roster_id, score: r1(score), reasons: [] });
        }
      }
    }
    found.sort((x, y) => y.score - x.score);
    // keep the best couple per partner, without reusing the same headline player
    const used = new Set<string>();
    for (const idea of found) {
      const key = [...idea.a.gives, ...idea.a.gets].join(",");
      const head = idea.a.gets[0];
      if (used.has(head) || used.has(key)) continue;
      used.add(head);
      used.add(key);
      idea.reasons = tradeReasons(idea, ctx, strength, me.roster_id, other.roster_id);
      ideas.push(idea);
      if (used.size / 2 >= (options.perPartner ?? 2)) break;
    }
  }
  // Variety: each of your players appears in at most two suggestions.
  const offered = new Map<string, number>();
  const out: TradeIdea[] = [];
  for (const idea of ideas.sort((x, y) => y.score - x.score)) {
    if (idea.a.gives.some((id) => (offered.get(id) || 0) >= 2)) continue;
    for (const id of idea.a.gives) offered.set(id, (offered.get(id) || 0) + 1);
    out.push(idea);
    if (out.length >= (options.limit ?? 10)) break;
  }
  return out;
}

function groupsOf(ids: string[], ctx: TradeContext): string[] {
  return [...new Set(ids.map((id) => ctx.players.get(id)?.position).filter(Boolean) as string[])];
}

export function tradeReasons(
  e: TradeEval,
  ctx: TradeContext,
  strength: Map<number, Map<string, Strength>>,
  myId: number,
  theirId: number,
  names: { a: string; b: string } = { a: "Your", b: "Their" },
): string[] {
  const out: string[] = [];
  const mine = strength.get(myId);
  const theirs = strength.get(theirId);
  const teams = strength.size;
  for (const pos of groupsOf(e.a.gets, ctx)) {
    const s = mine?.get(pos);
    if (s && s.rank > teams / 2) out.push(`Fixes your ${pos}: you're ${ordinal(s.rank)} of ${teams} (${signed(s.diff)} a week vs average)`);
  }
  for (const pos of groupsOf(e.a.gives, ctx)) {
    const s = mine?.get(pos);
    if (s && s.rank <= teams / 3) out.push(`You can spare a ${pos}: you're ${ordinal(s.rank)} at ${pos} (${signed(s.diff)} a week)`);
  }
  for (const pos of groupsOf(e.b.gets, ctx)) {
    const s = theirs?.get(pos);
    if (s && s.rank > teams / 2) out.push(`They need a ${pos}: ${ordinal(s.rank)} of ${teams} (${signed(s.diff)} a week)`);
  }
  for (const pos of groupsOf(e.b.gives, ctx)) {
    const s = theirs?.get(pos);
    if (s && s.rank <= teams / 3) out.push(`They're deep at ${pos}: ${ordinal(s.rank)} (${signed(s.diff)} a week)`);
  }
  const possessive = (n: string) => (n === "Your" || n === "Their" ? n : `${n}'s`);
  out.push(
    `${possessive(names.a)} starting lineup: ${signed(e.a.ros_gain)} pts rest of season (${signed(e.a.playoff_gain)} in the playoffs); ${possessive(names.b)}: ${signed(e.b.ros_gain)} (${signed(e.b.playoff_gain)} in the playoffs)`,
  );
  const pct = Math.round((e.value_ratio_b - 1) * 100);
  out.push(
    Math.abs(pct) <= 5
      ? "Even on trade value (FantasyCalc), so it's an easy sell"
      : pct > 0
        ? `They get ${pct}% more trade value than they give, which helps it get accepted`
        : `They give up ${-pct}% more trade value; they may want a small add-on`,
  );
  if (e.b.gets.length > e.b.gives.length) out.push("They'd need to drop a bench player to make room");
  if (e.a.gets.length > e.a.gives.length) out.push("You'd need to drop a bench player to make room");
  return out;
}

const signed = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(1)}`;

function ordinal(n: number) {
  const v = n % 100;
  const s = ["th", "st", "nd", "rd"];
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ---------- how a past trade played out ----------

export interface PlayedSide {
  roster_id: number;
  /** Points the received players scored in this team's starting lineup. */
  started: number;
  /** All points they scored for this team, bench included. */
  total: number;
  players: { player_id: string; started: number; total: number; starts: number; weeks: number }[];
}

/**
 * Actual results after a trade: for each scored week after the trade, the
 * points each team's incoming players scored for it (as starters, and in
 * total). Players later dropped or traded on count only while rostered.
 */
export function playedOut(
  weeks: { week: number; matchups: { roster_id: number; starters?: string[]; players?: string[]; players_points?: Record<string, number> }[] }[],
  tradeWeek: number,
  a: { roster_id: number; gets: string[] },
  b: { roster_id: number; gets: string[] },
): { from_week: number; to_week: number; a: PlayedSide; b: PlayedSide } | null {
  const after = weeks.filter((w) => w.week > tradeWeek);
  if (!after.length) return null;
  const side = (rid: number, gets: string[]): PlayedSide => {
    const players = gets.map((id) => ({ player_id: id, started: 0, total: 0, starts: 0, weeks: 0 }));
    for (const w of after) {
      const m = w.matchups.find((x) => x.roster_id === rid);
      if (!m) continue;
      for (const p of players) {
        if (!(m.players || []).includes(p.player_id)) continue;
        const pts = m.players_points?.[p.player_id] ?? 0;
        p.weeks++;
        p.total += pts;
        if ((m.starters || []).includes(p.player_id)) {
          p.started += pts;
          p.starts++;
        }
      }
    }
    for (const p of players) {
      p.started = r1(p.started);
      p.total = r1(p.total);
    }
    return {
      roster_id: rid,
      started: r1(players.reduce((t, p) => t + p.started, 0)),
      total: r1(players.reduce((t, p) => t + p.total, 0)),
      players,
    };
  };
  return {
    from_week: after[0].week,
    to_week: after[after.length - 1].week,
    a: side(a.roster_id, a.gets),
    b: side(b.roster_id, b.gets),
  };
}
