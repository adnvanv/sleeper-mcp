/**
 * Waiver advisor: who to add, who to drop, and why.
 *
 * Method: for every remaining week through the fantasy playoffs, take
 * Sleeper's projection for each player (re-scored in league scoring) and fill
 * your best possible starting lineup. Summed over the weeks, that's your
 * team's rest-of-season (ROS) projected starting points. A move "drop X, add
 * Y" is worth exactly how much it raises that total. This accounts for
 * byes, injuries (an out player projects 0), positional need and flex
 * eligibility at once, so a great bench player behind your starters doesn't
 * look like an upgrade.
 *
 * Reasons shown with each move come from usage trends, recent scoring,
 * playoff schedule, Sleeper-wide adds, trade value and news.
 */

import { optimalLineup, playerPositions, startingSlots } from "../season.js";
import type { SleeperPlayer } from "../types.js";
import type { NewsKind } from "./news.js";
import type { UsageTrend } from "./analysis.js";

const r1 = (n: number) => Math.round(n * 10) / 10;

export interface PlayerNewsBrief {
  title: string;
  kind: NewsKind;
  published: string;
  url: string;
}

export interface AdvisorInput {
  fromWeek: number;
  throughWeek: number;
  playoffStart: number;
  rosterPositions: string[];
  /** Your starters + bench (IR and taxi spots don't count: dropping them frees nothing). */
  myIds: string[];
  /** Every player on any roster in the league, yours included. */
  rostered: Set<string>;
  players: Map<string, SleeperPlayer>;
  /** week → player_id → projected points (league scoring). */
  projections: Map<number, Map<string, number>>;
  /** Fresh injury status where known (overrides the daily player database). */
  injuries: Map<string, string | null>;
  /** player_id → points by week (league scoring), from weekly stats. */
  history: Map<string, Map<number, number>>;
  usage: Map<string, UsageTrend>;
  /** Average opponent rank in the fantasy playoffs (1 = easiest of 32). */
  playoffRank: Map<string, number | null>;
  byeWeek: Map<string, number | null>;
  trendingAdds: Map<string, number>;
  values: Map<string, number>;
  news: Map<string, PlayerNewsBrief>;
  /** Players dropped recently, still on waivers: player_id → clears at (ISO). */
  waivers: Map<string, string>;
  now?: Date;
}

export interface PlayerCard {
  player_id: string;
  name: string;
  position: string;
  team: string | null;
  injury_status: string | null;
  ros_points: number;
  ros_ppg: number | null;
  ros_games: number;
  next_week: number | null;
  season_ppg: number | null;
  last3_ppg: number | null;
  snap_share: number | null;
  snap_change: number | null;
  playoff_rank: number | null;
  bye_week: number | null;
  trending_adds: number;
  value: number;
  news: PlayerNewsBrief | null;
  on_waivers_until: string | null;
}

export interface Move {
  add: PlayerCard;
  drop: PlayerCard;
  ros_gain: number;
  playoff_gain: number;
  next_week_gain: number;
  add_reasons: string[];
  drop_reasons: string[];
}

export interface DropCandidate {
  player: PlayerCard;
  /** Starting points you'd lose over the rest of the season without him. */
  ros_contribution: number;
  playoff_contribution: number;
  verdict: "drop" | "expendable" | "keep";
  reasons: string[];
}

export interface AdvisorResult {
  from_week: number;
  through_week: number;
  playoff_start: number;
  team_ros_points: number;
  moves: Move[];
  drops: DropCandidate[];
  available: Record<string, PlayerCard[]>;
}

const RISKY = new Set(["Out", "IR", "Doubtful", "Suspended", "PUP", "NA"]);

function weekList(from: number, through: number): number[] {
  const out: number[] = [];
  for (let w = from; w <= through; w++) out.push(w);
  return out;
}

export function buildCard(id: string, input: AdvisorInput): PlayerCard {
  const p = input.players.get(id);
  const weeks = weekList(input.fromWeek, input.throughWeek);
  const proj = weeks.map((w) => input.projections.get(w)?.get(id) ?? 0);
  const games = proj.filter((v) => v > 0).length;
  const ros = proj.reduce((a, b) => a + b, 0);
  const hist = input.history.get(id);
  const played = hist ? [...hist.entries()].sort((a, b) => a[0] - b[0]).filter(([, pts]) => pts !== 0) : [];
  const avg = (xs: number[]) => (xs.length ? r1(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  const usage = input.usage.get(id);
  return {
    player_id: id,
    name: p ? `${p.first_name} ${p.last_name}`.trim() : id,
    position: p?.position || "?",
    team: p?.team || null,
    injury_status: input.injuries.has(id) ? input.injuries.get(id) || null : p?.injury_status || null,
    ros_points: r1(ros),
    ros_ppg: games ? r1(ros / games) : null,
    ros_games: games,
    next_week: input.projections.get(input.fromWeek)?.has(id)
      ? r1(input.projections.get(input.fromWeek)!.get(id)!)
      : null,
    season_ppg: avg(played.map(([, pts]) => pts)),
    last3_ppg: avg(played.slice(-3).map(([, pts]) => pts)),
    snap_share: usage?.recent.snap_share ?? null,
    snap_change: usage?.change.snap_share ?? null,
    playoff_rank: input.playoffRank.get(id) ?? null,
    bye_week: input.byeWeek.get(id) ?? null,
    trending_adds: input.trendingAdds.get(id) || 0,
    value: input.values.get(id) || 0,
    news: input.news.get(id) || null,
    on_waivers_until: input.waivers.get(id) || null,
  };
}

/** Best-lineup projected points per week for a set of player IDs. */
export function lineupByWeek(ids: string[], input: AdvisorInput): Map<number, number> {
  const positions = (id: string) => playerPositions(input.players.get(id));
  const out = new Map<number, number>();
  for (const w of weekList(input.fromWeek, input.throughWeek)) {
    const proj = input.projections.get(w);
    out.set(w, optimalLineup(ids, input.rosterPositions, (id) => proj?.get(id) ?? 0, positions).total);
  }
  return out;
}

const sum = (m: Map<number, number>, filter: (w: number) => boolean = () => true) =>
  [...m.entries()].filter(([w]) => filter(w)).reduce((a, [, v]) => a + v, 0);

function startablePositions(rosterPositions: string[]): Set<string> {
  const map: Record<string, string[]> = {
    QB: ["QB"], RB: ["RB"], WR: ["WR"], TE: ["TE"], K: ["K"], DEF: ["DEF"],
    FLEX: ["RB", "WR", "TE"], WRRB_FLEX: ["WR", "RB"], REC_FLEX: ["WR", "TE"],
    SUPER_FLEX: ["QB", "RB", "WR", "TE"],
  };
  return new Set(startingSlots(rosterPositions).flatMap((s) => map[s] || []));
}

const fmtAdds = (n: number) => (n >= 1000 ? `${Math.round(n / 100) / 10}K` : String(n));
const daysAgo = (iso: string, now: Date) => (now.getTime() - Date.parse(iso)) / 86400000;

function addReasons(add: PlayerCard, drop: PlayerCard, input: AdvisorInput, usage?: UsageTrend): string[] {
  const now = input.now || new Date();
  const out: string[] = [];
  if (add.ros_ppg != null) {
    out.push(
      `Projects ${add.ros_ppg} pts a game the rest of the way (${add.ros_games} games)` +
        (drop.ros_ppg != null ? ` vs ${drop.ros_ppg} for ${drop.name}` : ""),
    );
  }
  if (add.ros_games > drop.ros_games) {
    out.push(
      `Plays ${add.ros_games} of the remaining games to ${drop.name}'s ${drop.ros_games}` +
        (drop.bye_week != null && drop.bye_week >= input.fromWeek ? ` (bye week ${drop.bye_week})` : ""),
    );
  }
  if (usage && usage.reason && (usage.change.opportunities >= 2 || (usage.change.snap_share ?? 0) >= 0.08)) {
    out.push(`Role growing: ${usage.reason} (last 2 games vs before)`);
  }
  if (add.last3_ppg != null && add.season_ppg != null && add.last3_ppg >= add.season_ppg + 2) {
    out.push(`Heating up: ${add.last3_ppg} pts a game over his last 3 vs ${add.season_ppg} on the season`);
  }
  if (add.news && daysAgo(add.news.published, now) <= 7 && ["returning", "role"].includes(add.news.kind)) {
    out.push(`News: ${add.news.title}`);
  }
  if (add.playoff_rank != null && add.playoff_rank <= 10) {
    out.push(`Soft playoff schedule: opponents average rank ${add.playoff_rank} of 32 vs his position in weeks ${input.playoffStart}+`);
  }
  if (add.trending_adds >= 1000) out.push(`${fmtAdds(add.trending_adds)} Sleeper managers added him in the last 24h`);
  if (add.value > drop.value + 300) {
    out.push(`Higher trade value (FantasyCalc ${add.value.toLocaleString()} vs ${drop.value.toLocaleString()})`);
  }
  return out.slice(0, 5);
}

function dropReasons(drop: PlayerCard, contribution: number, input: AdvisorInput, usage?: UsageTrend): string[] {
  const now = input.now || new Date();
  const out: string[] = [];
  if (drop.injury_status && RISKY.has(drop.injury_status)) {
    out.push(`Listed ${drop.injury_status}${drop.ros_games < input.throughWeek - input.fromWeek + 1 ? `; projected to play ${drop.ros_games} of the remaining ${input.throughWeek - input.fromWeek + 1} weeks` : ""}`);
  }
  if (drop.news && daysAgo(drop.news.published, now) <= 7 && drop.news.kind === "injury") {
    out.push(`News: ${drop.news.title}`);
  }
  out.push(
    contribution < 1
      ? "Wouldn't make your best lineup in any remaining week"
      : `Adds only ${r1(contribution)} starting points to your lineup the rest of the season`,
  );
  if (usage && ((usage.change.snap_share ?? 0) <= -0.08 || usage.change.opportunities <= -2) && usage.reason) {
    out.push(`Role shrinking: ${usage.reason}`);
  }
  if (drop.last3_ppg != null && drop.season_ppg != null && drop.last3_ppg <= drop.season_ppg - 2) {
    out.push(`Cooling off: ${drop.last3_ppg} pts a game over his last 3 vs ${drop.season_ppg} on the season`);
  }
  if (drop.bye_week != null && drop.bye_week >= input.fromWeek) out.push(`Still has his bye (week ${drop.bye_week})`);
  if (drop.playoff_rank != null && drop.playoff_rank >= 22) {
    out.push(`Tough playoff schedule: opponents average rank ${drop.playoff_rank} of 32`);
  }
  return out.slice(0, 5);
}

export function advise(input: AdvisorInput, options: { candidates?: number; moves?: number } = {}): AdvisorResult {
  const startable = startablePositions(input.rosterPositions);
  const isPlayoff = (w: number) => w >= input.playoffStart;
  const base = lineupByWeek(input.myIds, input);
  const baseRos = sum(base);
  const basePo = sum(base, isPlayoff);
  const nextWeek = (m: Map<number, number>) => m.get(input.fromWeek) ?? 0;

  const cards = new Map<string, PlayerCard>();
  const card = (id: string) => {
    if (!cards.has(id)) cards.set(id, buildCard(id, input));
    return cards.get(id)!;
  };

  // How much each of your players adds to your best lineups.
  const contribution = new Map<string, { ros: number; po: number }>();
  for (const id of input.myIds) {
    const without = lineupByWeek(input.myIds.filter((x) => x !== id), input);
    contribution.set(id, { ros: baseRos - sum(without), po: basePo - sum(without, isPlayoff) });
  }

  // Free agents worth testing: best ROS projections per position, plus any
  // trending or rising player even if projections haven't caught up.
  const freeAgents: string[] = [];
  for (const [id, p] of input.players) {
    if (input.rostered.has(id) || !p.team) continue;
    if (!startable.has(p.position)) continue;
    freeAgents.push(id);
  }
  const rosOf = (id: string) => {
    let t = 0;
    for (let w = input.fromWeek; w <= input.throughWeek; w++) t += input.projections.get(w)?.get(id) ?? 0;
    return t;
  };
  const byPos = new Map<string, string[]>();
  for (const id of freeAgents) {
    const pos = input.players.get(id)!.position;
    byPos.set(pos, [...(byPos.get(pos) || []), id]);
  }
  const perPos = Math.max(4, Math.ceil((options.candidates ?? 48) / Math.max(1, byPos.size)));
  const pool = new Set<string>();
  for (const ids of byPos.values()) {
    ids.sort((a, b) => rosOf(b) - rosOf(a)).slice(0, perPos).forEach((id) => pool.add(id));
  }
  for (const id of freeAgents) {
    const u = input.usage.get(id);
    if ((input.trendingAdds.get(id) || 0) >= 500 || (u && u.change.opportunities >= 3)) pool.add(id);
  }

  // Test every add against every drop; keep the best drop for each add.
  const moves: Move[] = [];
  for (const add of pool) {
    let best: { drop: string; ros: number; po: number; next: number } | null = null;
    for (const drop of input.myIds) {
      const ids = [...input.myIds.filter((x) => x !== drop), add];
      const after = lineupByWeek(ids, input);
      const ros = sum(after) - baseRos;
      if (!best || ros > best.ros) {
        best = { drop, ros, po: sum(after, isPlayoff) - basePo, next: nextWeek(after) - nextWeek(base) };
      }
    }
    if (!best || best.ros < 1) continue;
    const a = card(add);
    const d = card(best.drop);
    moves.push({
      add: a,
      drop: d,
      ros_gain: r1(best.ros),
      playoff_gain: r1(best.po),
      next_week_gain: r1(best.next),
      add_reasons: addReasons(a, d, input, input.usage.get(add)),
      drop_reasons: dropReasons(d, contribution.get(best.drop)?.ros ?? 0, input, input.usage.get(best.drop)),
    });
  }
  moves.sort((a, b) => b.ros_gain - a.ros_gain);

  const drops: DropCandidate[] = input.myIds
    .map((id) => {
      const c = contribution.get(id)!;
      const verdict: DropCandidate["verdict"] = c.ros < 3 ? "drop" : c.ros < 12 ? "expendable" : "keep";
      return {
        player: card(id),
        ros_contribution: r1(c.ros),
        playoff_contribution: r1(c.po),
        verdict,
        reasons: verdict === "keep"
          ? [`Adds ${r1(c.ros)} starting points the rest of the season (${r1(c.po)} in the playoffs)`]
          : dropReasons(card(id), c.ros, input, input.usage.get(id)),
      };
    })
    .sort((a, b) => a.ros_contribution - b.ros_contribution);

  const available: Record<string, PlayerCard[]> = {};
  for (const [pos, ids] of byPos) {
    available[pos] = ids
      .slice(0, 8)
      .map(card)
      .filter((c) => c.ros_points > 0);
  }

  return {
    from_week: input.fromWeek,
    through_week: input.throughWeek,
    playoff_start: input.playoffStart,
    team_ros_points: r1(baseRos),
    moves: moves.slice(0, options.moves ?? 10),
    drops,
    available,
  };
}
