import {
  optimalLineup,
  playerPositions,
  rosterPlayerIds,
  startingSlots,
  teamName,
  type PlayerStat,
} from "./season.js";
import type {
  SleeperLeagueUser,
  SleeperPlayer,
  SleeperRoster,
} from "./types.js";

const TRADE_POSITIONS = ["QB", "RB", "WR", "TE"];
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface TradeFinderInput {
  myRosterId: number;
  rosters: SleeperRoster[];
  users: SleeperLeagueUser[];
  players: Map<string, SleeperPlayer>;
  stats: Map<string, PlayerStat>;
  rosterPositions: string[];
  /** Only suggest trades where you receive this position. */
  targetPosition?: string;
  /** Minimum ppg gain for your lineup to suggest a trade. */
  minGain?: number;
  limit?: number;
}

export interface PositionReport {
  position: string;
  your_starter_ppg: number;
  league_avg_starter_ppg: number;
  rank: number;
  teams: number;
  verdict: "strength" | "average" | "need";
  surplus: { name: string; ppg: number }[];
}

/**
 * Trade value: points per game, shrunk toward zero for tiny samples so a
 * one-week wonder doesn't look like a star.
 */
export function playerValue(stat?: PlayerStat): number {
  if (!stat || !stat.games) return 0;
  const weight = Math.min(stat.games, 3) / 3;
  return r2(stat.ppg * weight);
}

function name(players: Map<string, SleeperPlayer>, id: string): string {
  const p = players.get(id);
  return p ? `${p.first_name || ""} ${p.last_name || ""}`.trim() : id;
}

/**
 * For each position, average ppg of the players a team would start in its
 * dedicated slots (QB, RB, WR, TE), ranked against the league.
 */
export function positionReports(input: TradeFinderInput): PositionReport[] {
  const { rosters, players, stats, rosterPositions, myRosterId } = input;
  const value = (id: string) => playerValue(stats.get(id));
  const positionsOf = (id: string) => playerPositions(players.get(id));

  const perTeam = new Map<number, Map<string, number[]>>();
  const benchByTeam = new Map<number, string[]>();
  for (const roster of rosters) {
    const lineup = optimalLineup(
      rosterPlayerIds(roster),
      rosterPositions,
      value,
      positionsOf,
    );
    const byPos = new Map<string, number[]>();
    for (const s of lineup.starters) {
      if (!TRADE_POSITIONS.includes(s.slot)) continue;
      byPos.set(s.slot, [...(byPos.get(s.slot) || []), s.value]);
    }
    perTeam.set(roster.roster_id, byPos);
    benchByTeam.set(roster.roster_id, lineup.bench);
  }

  const avg = (xs: number[]) =>
    xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  const positions = TRADE_POSITIONS.filter((p) =>
    startingSlots(rosterPositions).includes(p),
  );

  return positions.map((position) => {
    const teamAvgs = rosters.map((r) => ({
      id: r.roster_id,
      avg: avg(perTeam.get(r.roster_id)?.get(position) || []),
    }));
    teamAvgs.sort((a, b) => b.avg - a.avg);
    const rank = teamAvgs.findIndex((t) => t.id === myRosterId) + 1;
    const mine = teamAvgs.find((t) => t.id === myRosterId)?.avg || 0;
    const leagueAvg = avg(teamAvgs.map((t) => t.avg));
    const third = Math.max(1, Math.round(rosters.length / 3));
    const verdict =
      rank <= third
        ? "strength"
        : rank > rosters.length - third
          ? "need"
          : "average";

    // Bench players at this position who'd start somewhere in the league
    const worstStarter = Math.min(
      ...teamAvgs.map((t) => t.avg).filter((v) => v > 0),
    );
    const surplus = (benchByTeam.get(myRosterId) || [])
      .filter((id) => positionsOf(id).includes(position))
      .map((id) => ({ name: name(players, id), ppg: value(id) }))
      .filter((p) => p.ppg >= worstStarter * 0.8 && p.ppg > 0)
      .sort((a, b) => b.ppg - a.ppg);

    return {
      position,
      your_starter_ppg: r2(mine),
      league_avg_starter_ppg: r2(leagueAvg),
      rank,
      teams: rosters.length,
      verdict,
      surplus,
    };
  });
}

/**
 * Replacement level per position: the ppg of the first rostered player
 * beyond what the league starts in dedicated slots (e.g. the 13th-best QB
 * in a 12-team 1-QB league). Value over replacement (VOR) makes a QB's
 * 22 ppg comparable with an RB's 15.
 */
export function replacementLevels(
  rosters: SleeperRoster[],
  rosterPositions: string[],
  value: (id: string) => number,
  positionsOf: (id: string) => string[],
): Map<string, number> {
  const slots = startingSlots(rosterPositions);
  const allIds = [...new Set(rosters.flatMap(rosterPlayerIds))];
  const levels = new Map<string, number>();
  for (const pos of TRADE_POSITIONS) {
    const starters = slots.filter((s) => s === pos).length * rosters.length;
    const values = allIds
      .filter((id) => positionsOf(id)[0] === pos)
      .map(value)
      .sort((a, b) => b - a);
    levels.set(pos, values[Math.min(starters, values.length - 1)] ?? 0);
  }
  return levels;
}

export interface TradePlayer {
  player_id: string;
  name: string;
  position: string;
  ppg: number;
  /** Points per game over a replacement-level player at the position. */
  vor: number;
}

export interface TradeIdea {
  partner: string;
  partner_roster_id: number;
  you_give: TradePlayer;
  you_get: TradePlayer;
  your_lineup_gain: number;
  their_lineup_gain: number;
  why: string;
}

/**
 * Try every 1-for-1 swap with every other team and keep the ones that make
 * BOTH optimal lineups better (by ppg) and are roughly even in value over
 * replacement, so you aren't asking for a star for a backup. Those are the
 * trades a rival might actually accept. Ranked by the smaller of the two
 * lineup gains, so lopsided offers sink.
 */
export function findTrades(input: TradeFinderInput): TradeIdea[] {
  const {
    myRosterId,
    rosters,
    users,
    players,
    stats,
    rosterPositions,
    targetPosition,
    minGain = 0.25,
    limit = 10,
  } = input;
  const value = (id: string) => playerValue(stats.get(id));
  const positionsOf = (id: string) => playerPositions(players.get(id));
  const tradeable = (id: string) =>
    value(id) > 0 && positionsOf(id).some((p) => TRADE_POSITIONS.includes(p));
  const lineupTotal = (ids: string[]) =>
    optimalLineup(ids, rosterPositions, value, positionsOf).total;
  const levels = replacementLevels(
    rosters,
    rosterPositions,
    value,
    positionsOf,
  );
  const vor = (id: string) =>
    r2(value(id) - (levels.get(positionsOf(id)[0]) ?? 0));
  // You may ask for at most this much more VOR than you send
  const fairEnough = (giveVor: number, getVor: number) =>
    getVor - giveVor <= Math.max(1.5, Math.abs(giveVor) * 0.3);
  const toTradePlayer = (id: string): TradePlayer => ({
    player_id: id,
    name: name(players, id),
    position: players.get(id)?.position || positionsOf(id)[0],
    ppg: value(id),
    vor: vor(id),
  });

  const me = rosters.find((r) => r.roster_id === myRosterId);
  if (!me) return [];
  const myIds = rosterPlayerIds(me);
  const myBase = lineupTotal(myIds);
  const userMap = new Map(users.map((u) => [u.user_id, u]));
  const want = targetPosition?.toUpperCase();

  const ideas: TradeIdea[] = [];
  for (const other of rosters) {
    if (other.roster_id === myRosterId) continue;
    const theirIds = rosterPlayerIds(other);
    const theirBase = lineupTotal(theirIds);
    const partner = teamName(other, userMap.get(other.owner_id));

    for (const give of myIds.filter(tradeable)) {
      for (const get of theirIds.filter(tradeable)) {
        if (want && !positionsOf(get).includes(want)) continue;
        if (!fairEnough(vor(give), vor(get))) continue;
        const myGain = r2(
          lineupTotal([...myIds.filter((id) => id !== give), get]) - myBase,
        );
        if (myGain < minGain) continue;
        const theirGain = r2(
          lineupTotal([...theirIds.filter((id) => id !== get), give]) -
            theirBase,
        );
        if (theirGain <= 0) continue;

        const youGive = toTradePlayer(give);
        const youGet = toTradePlayer(get);
        const givePos = youGive.position;
        const getPos = youGet.position;
        ideas.push({
          partner,
          partner_roster_id: other.roster_id,
          you_give: youGive,
          you_get: youGet,
          your_lineup_gain: myGain,
          their_lineup_gain: theirGain,
          why:
            givePos === getPos
              ? `Both lineups improve at ${givePos} (+${myGain} for you, +${theirGain} for them)`
              : `You have ${givePos} depth and need ${getPos}; they're the reverse (+${myGain} for you, +${theirGain} for them)`,
        });
      }
    }
  }

  ideas.sort(
    (a, b) =>
      Math.min(b.your_lineup_gain, b.their_lineup_gain) -
        Math.min(a.your_lineup_gain, a.their_lineup_gain) ||
      b.your_lineup_gain - a.your_lineup_gain,
  );

  // At most two ideas per partner so one team doesn't fill the list
  const perPartner = new Map<number, number>();
  return ideas
    .filter((idea) => {
      const n = perPartner.get(idea.partner_roster_id) || 0;
      if (n >= 2) return false;
      perPartner.set(idea.partner_roster_id, n + 1);
      return true;
    })
    .slice(0, limit);
}
