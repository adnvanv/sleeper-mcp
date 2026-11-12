import type {
  SleeperLeagueUser,
  SleeperMatchup,
  SleeperRoster,
} from "./types.js";
import { playedWeeks, teamName, type WeekScores } from "./season.js";

export { playedWeeks, type WeekScores };

export interface AllPlayRecord {
  roster_id: number;
  team_name: string;
  owner: string;
  owner_id: string;
  actual: { wins: number; losses: number; ties: number; win_pct: number };
  all_play: { wins: number; losses: number; ties: number; win_pct: number };
  /** Sum of weekly all-play win shares: wins a team "deserved" by score. */
  expected_wins: number;
  /** Head-to-head wins minus expected wins. Positive = lucky, negative = unlucky. */
  luck: number;
  points_for: number;
  weekly_high_scores: number;
  all_play_rank: number;
  actual_rank: number;
}

const round = (n: number, places = 3) => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

const winPct = (w: number, l: number, t: number) =>
  w + l + t === 0 ? 0 : round((w + t / 2) / (w + l + t));

export interface AllPlayOptions {
  /** League also plays everyone against the weekly median score. */
  medianGame?: boolean;
}

/**
 * Each week, every team plays every other team. Wins/losses come from
 * comparing points; equal scores are ties. Actual records are rebuilt from
 * the same weeks' head-to-head matchups (plus the median game if the league
 * uses one), so both records always cover the same weeks.
 */
export function computeAllPlay(
  weeks: WeekScores[],
  rosters: SleeperRoster[],
  users: SleeperLeagueUser[],
  options: AllPlayOptions = {},
): AllPlayRecord[] {
  const userMap = new Map(users.map((u) => [u.user_id, u]));
  const stats = new Map(
    rosters.map((r) => [
      r.roster_id,
      {
        wins: 0,
        losses: 0,
        ties: 0,
        expected: 0,
        points: 0,
        highs: 0,
        aw: 0,
        al: 0,
        at: 0,
        h2hWins: 0,
      },
    ]),
  );

  for (const { matchups } of playedWeeks(weeks)) {
    const scores = matchups
      .filter((m) => stats.has(m.roster_id))
      .map((m) => ({ id: m.roster_id, pts: m.points || 0 }));
    if (scores.length < 2) continue;
    const top = Math.max(...scores.map((s) => s.pts));

    // Actual head-to-head results, paired by matchup_id
    const pairs = new Map<number, SleeperMatchup[]>();
    for (const m of matchups) {
      if (m.matchup_id == null || !stats.has(m.roster_id)) continue;
      pairs.set(m.matchup_id, [...(pairs.get(m.matchup_id) || []), m]);
    }
    for (const pair of pairs.values()) {
      if (pair.length !== 2) continue;
      for (const [me, opp] of [pair, [pair[1], pair[0]]]) {
        const s = stats.get(me.roster_id)!;
        const diff = (me.points || 0) - (opp.points || 0);
        if (diff > 0) {
          s.aw++;
          s.h2hWins++;
        } else if (diff < 0) {
          s.al++;
        } else {
          s.at++;
          s.h2hWins += 0.5;
        }
      }
    }

    if (options.medianGame) {
      const sorted = scores.map((s) => s.pts).sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const median =
        sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      for (const me of scores) {
        const s = stats.get(me.id)!;
        if (me.pts > median) s.aw++;
        else if (me.pts < median) s.al++;
        else s.at++;
      }
    }

    for (const me of scores) {
      const s = stats.get(me.id)!;
      let w = 0,
        l = 0,
        t = 0;
      for (const other of scores) {
        if (other.id === me.id) continue;
        if (me.pts > other.pts) w++;
        else if (me.pts < other.pts) l++;
        else t++;
      }
      s.wins += w;
      s.losses += l;
      s.ties += t;
      s.expected += (w + t / 2) / (scores.length - 1);
      s.points += me.pts;
      if (me.pts === top) s.highs++;
    }
  }

  const records: AllPlayRecord[] = rosters.map((roster) => {
    const s = stats.get(roster.roster_id)!;
    const actualWins = s.aw;
    const actualLosses = s.al;
    const actualTies = s.at;
    const user = userMap.get(roster.owner_id);
    return {
      roster_id: roster.roster_id,
      team_name: teamName(roster, user),
      owner: user?.display_name || "Unknown",
      owner_id: roster.owner_id,
      actual: {
        wins: actualWins,
        losses: actualLosses,
        ties: actualTies,
        win_pct: winPct(actualWins, actualLosses, actualTies),
      },
      all_play: {
        wins: s.wins,
        losses: s.losses,
        ties: s.ties,
        win_pct: winPct(s.wins, s.losses, s.ties),
      },
      expected_wins: round(s.expected, 2),
      // Median games are decided by score alone, so luck is head-to-head only
      luck: round(s.h2hWins - s.expected, 2),
      points_for: round(s.points, 2),
      weekly_high_scores: s.highs,
      all_play_rank: 0,
      actual_rank: 0,
    };
  });

  // Actual standings: win% then points for (Sleeper's default tiebreaker).
  [...records]
    .sort(
      (x, y) =>
        y.actual.win_pct - x.actual.win_pct || y.points_for - x.points_for,
    )
    .forEach((r, i) => (r.actual_rank = i + 1));

  records.sort(
    (x, y) =>
      y.all_play.win_pct - x.all_play.win_pct || y.points_for - x.points_for,
  );
  records.forEach((r, i) => (r.all_play_rank = i + 1));

  return records;
}

/**
 * Last regular-season week to count: the requested week if given, otherwise
 * the last week Sleeper has finished scoring, never past the regular season.
 */
export function resolveThroughWeek(opts: {
  requested?: number;
  lastScoredWeek?: number;
  currentWeek: number;
  playoffWeekStart?: number;
}): number {
  const lastRegular = opts.playoffWeekStart ? opts.playoffWeekStart - 1 : 18;
  const target =
    opts.requested ?? opts.lastScoredWeek ?? Math.max(opts.currentWeek - 1, 0);
  return Math.max(0, Math.min(target, lastRegular));
}
