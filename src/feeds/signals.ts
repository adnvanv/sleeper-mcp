/**
 * Signals that projections are slow to catch: what the news says about a
 * player's health and role, how he's actually been used in the games he
 * played, and what the rest of Sleeper is doing with him.
 *
 * These feed an adjusted rest-of-season points-per-game estimate that blends
 * Sleeper's projection with recent usage. The blend leans further toward
 * recent usage the more real games there are to go on and when the market
 * (Sleeper-wide adds) agrees with it.
 */

import type { NewsItem } from "./news.js";
import { leaguePoints, type WeeklyRow } from "./analysis.js";

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

// ---------- reading the news ----------

export interface NewsSignals {
  /** Back from a long absence (activated, first game since…). */
  returned: boolean;
  /** Latest practice report in the last week, if any. */
  practice: "full" | "limited" | "dnp" | null;
  /** Depth role named in the news (1 = top option). */
  role_rank: number | null;
  /** Routes run per dropback, when the blurb gives both numbers. */
  route_share: number | null;
  /** "eased in", "snap count", "ramp up": usage expected to grow. */
  ramping: boolean;
  /** Out, IR, season-ending, etc. in the last week. */
  out: boolean;
  /** Short quotes from the articles that back these up. */
  quotes: { source: string; date: string; text: string }[];
}

const ORDINAL: Record<string, number> = {
  "no. 1": 1, "no.1": 1, "top": 1, "lead": 1, "primary": 1, wr1: 1, rb1: 1, te1: 1,
  "no. 2": 2, "no.2": 2, "second": 2, wr2: 2, rb2: 2, "complementary": 2,
  "no. 3": 3, "no.3": 3, "third": 3, wr3: 3,
};

/** Sentence ends: a period then space/end, not after an initial like "C.J." */
const SENTENCE_END = /(?<!\b[A-Z])\.(?=\s|$)/g;

/** The sentence around a match, trimmed to a readable quote. */
export function quoteAround(text: string, index: number): string {
  let start = 0;
  let end = text.length;
  SENTENCE_END.lastIndex = 0;
  for (let m = SENTENCE_END.exec(text); m; m = SENTENCE_END.exec(text)) {
    if (m.index < index) start = m.index + 1;
    else {
      end = m.index + 1;
      break;
    }
  }
  let q = text.slice(start, end).trim();
  if (q.length > 240) q = `${q.slice(0, 237).replace(/\s\S*$/, "")}…`;
  return q;
}

export function readNews(items: NewsItem[], now = new Date()): NewsSignals {
  const signals: NewsSignals = {
    returned: false,
    practice: null,
    role_rank: null,
    route_share: null,
    ramping: false,
    out: false,
    quotes: [],
  };
  const recent = items
    .filter((n) => now.getTime() - Date.parse(n.published) <= 21 * 86400000)
    .sort((a, b) => b.published.localeCompare(a.published));
  const quote = (n: NewsItem, text: string, index: number) => {
    const q = quoteAround(text, index);
    if (!signals.quotes.some((x) => x.text === q)) {
      signals.quotes.push({ source: n.source, date: n.published, text: q });
    }
  };
  for (const n of recent) {
    const text = `${n.title.replace(/[.\s]+$/, "")}. ${n.summary}`;
    const ageDays = (now.getTime() - Date.parse(n.published)) / 86400000;
    let m: RegExpExecArray | null;

    if (
      (m = /\b(first (?:game|appearance|action) since|activated from (?:injured reserve|ir|the pup list)|since returning from|made his return|return(?:ed)? to action|second (?:game|appearance) since)\b/i.exec(text))
    ) {
      if (!signals.returned) quote(n, text, m.index);
      signals.returned = true;
    }
    if (ageDays <= 7 && signals.practice === null) {
      if ((m = /\b(full participant|practiced (?:fully|in full)|full practice|logs full)\b/i.exec(text))) {
        signals.practice = "full";
        quote(n, text, m.index);
      } else if ((m = /\b(limited (?:in|at|participant)|was limited|logs limited)\b/i.exec(text))) {
        signals.practice = "limited";
        quote(n, text, m.index);
      } else if ((m = /\b(did not practice|didn't practice|non-participant|sat out (?:of )?practice|absent from practice)\b/i.exec(text))) {
        signals.practice = "dnp";
        quote(n, text, m.index);
      }
    }
    if (ageDays <= 7 && (m = /\b(ruled out|placed on (?:injured reserve|ir)|out for the season|season-ending|will miss)\b/i.exec(text))) {
      if (!signals.out) quote(n, text, m.index);
      signals.out = true;
    }
    if (
      signals.role_rank === null &&
      (m = /\b(no\. ?[123]|top|lead|primary|second|third|complementary|wr[123]|rb[12]|te1)\b[^.]{0,12}\b(receiver|wideout|option|target|back|running back|tight end)\b/i.exec(text))
    ) {
      const rank = ORDINAL[m[1].toLowerCase().replace(/\s+/g, " ")];
      if (rank) {
        signals.role_rank = rank;
        quote(n, text, m.index);
      }
    }
    if (signals.route_share === null && (m = /running (\d+) routes on .{0,40}?(\d+) (?:dropbacks|pass plays)/i.exec(text))) {
      const routes = Number(m[1]);
      const dropbacks = Number(m[2]);
      if (dropbacks > 0 && routes <= dropbacks) {
        signals.route_share = r2(routes / dropbacks);
        quote(n, text, m.index);
      }
    }
    if ((m = /\b(team-high \w+ targets|led the team in targets|team-high (?:\w+ )?(?:catches|receptions|carries))\b/i.exec(text))) {
      if (signals.quotes.length < 5) quote(n, text, m.index);
    }
    if ((m = /\b(eased (?:into|back)|snap count|ramp(?:ed|ing)? up|workload (?:should|will|could) (?:grow|increase))\b/i.exec(text))) {
      if (!signals.ramping) quote(n, text, m.index);
      signals.ramping = true;
    }
  }
  signals.quotes = signals.quotes.slice(0, 4);
  return signals;
}

// ---------- usage in games actually played ----------

export interface PlayedGame {
  week: number;
  points: number;
  snap_share: number | null;
  targets: number;
  carries: number;
  /** Points those touches are usually worth at his position (less TD luck). */
  expected_points: number;
}

/** Points per target and per carry at each position, from all games this season. */
export function pointsPerOpportunity(
  rows: WeeklyRow[],
  positionOf: (id: string) => string | undefined,
  scoring: Record<string, number>,
): Map<string, { per_target: number; per_carry: number }> {
  const acc = new Map<string, { recPts: number; tgt: number; rushPts: number; car: number }>();
  for (const r of rows) {
    const pos = positionOf(r.player_id);
    if (!pos || !["RB", "WR", "TE"].includes(pos) || !r.stats?.off_snp) continue;
    const s = r.stats;
    const rec = leaguePoints(
      { rec: s.rec || 0, rec_yd: s.rec_yd || 0, rec_td: s.rec_td || 0, bonus_rec_rb: s.bonus_rec_rb || 0, bonus_rec_wr: s.bonus_rec_wr || 0, bonus_rec_te: s.bonus_rec_te || 0 },
      scoring,
    );
    const rush = leaguePoints({ rush_yd: s.rush_yd || 0, rush_td: s.rush_td || 0 }, scoring);
    const a = acc.get(pos) || { recPts: 0, tgt: 0, rushPts: 0, car: 0 };
    a.recPts += rec;
    a.tgt += s.rec_tgt || 0;
    a.rushPts += rush;
    a.car += s.rush_att || 0;
    acc.set(pos, a);
  }
  const out = new Map<string, { per_target: number; per_carry: number }>();
  for (const [pos, a] of acc) {
    out.set(pos, {
      per_target: a.tgt ? r2(a.recPts / a.tgt) : 0,
      per_carry: a.car ? r2(a.rushPts / a.car) : 0,
    });
  }
  return out;
}

/** Games where the player actually took the field (at least one offensive snap or a stat). */
export function playedGames(
  rows: WeeklyRow[],
  position: string,
  scoring: Record<string, number>,
  ppo: Map<string, { per_target: number; per_carry: number }>,
): PlayedGame[] {
  const rate = ppo.get(position);
  return rows
    .filter((r) => r.stats && (r.stats.off_snp || r.stats.rec_tgt || r.stats.rush_att || r.stats.pass_att))
    .sort((a, b) => a.week - b.week)
    .map((r) => {
      const s = r.stats;
      const targets = s.rec_tgt || 0;
      const carries = s.rush_att || 0;
      const points = leaguePoints(s, scoring);
      return {
        week: r.week,
        points,
        snap_share: s.tm_off_snp ? r2((s.off_snp || 0) / s.tm_off_snp) : null,
        targets,
        carries,
        expected_points: rate ? r1(targets * rate.per_target + carries * rate.per_carry) : points,
      };
    });
}

// ---------- market ----------

export interface MarketSignal {
  adds_24h: number;
  add_rank: number | null;
  drops_24h: number;
  drop_rank: number | null;
}

// ---------- adjusted outlook ----------

export interface Outlook {
  /** Sleeper's projection, points a game over the remaining weeks he plays. */
  projected_ppg: number | null;
  /** Recent usage-based estimate from games played. */
  recent_ppg: number | null;
  /** Blend used by the advisor. */
  adjusted_ppg: number | null;
  /** Share of the blend that comes from recent usage (0-1). */
  recent_weight: number;
  games_played: number;
  last_games: PlayedGame[];
  news: NewsSignals;
  market: MarketSignal;
  /** Plain-language notes on why the estimate differs from the projection. */
  notes: string[];
  /** Strong reasons not to cut this player, even if the numbers say so. */
  hold_flags: string[];
}

const fmtK = (n: number) => (n >= 1000 ? `${r1(n / 1000)}K` : String(n));

export function outlook(input: {
  name: string;
  position: string;
  projectedPpg: number | null;
  games: PlayedGame[];
  news: NewsSignals;
  market: MarketSignal;
  /** NFL weeks of stats so far this season (to tell how many games he missed). */
  seasonWeeks?: number;
}): Outlook {
  const { games, market } = input;
  // "Returned" only counts if he actually missed a real stretch: at least 3
  // games beyond a bye. News about a short absence doesn't qualify.
  const missed = input.seasonWeeks != null ? input.seasonWeeks - 1 - games.length : 0;
  // ...and he has to be playing again (a game in the last two weeks).
  const lastPlayed = games.length ? games[games.length - 1].week : 0;
  const playingAgain = input.seasonWeeks == null || lastPlayed >= input.seasonWeeks - 1;
  const news = { ...input.news, returned: input.news.returned && missed >= 3 && playingAgain };
  const skill = !["QB", "K", "DEF"].includes(input.position);
  const last = games.slice(-3);
  const notes: string[] = [];
  const holds: string[] = [];

  // Recent rate: newer games count more, and a game well above the previous
  // snap share (a role still growing) counts most. Half actual points, half
  // usage-based expected points, so one long TD doesn't run the estimate.
  let recent: number | null = null;
  if (last.length && input.position !== "QB" && input.position !== "K" && input.position !== "DEF") {
    const weights = last.map((_, i) => [0.2, 0.3, 0.5].slice(-last.length)[i]);
    const latest = last[last.length - 1];
    const prev = last[last.length - 2];
    if (prev && latest.snap_share != null && prev.snap_share != null && latest.snap_share >= prev.snap_share * 1.5) {
      weights[weights.length - 1] += 0.3; // role clearly expanding
    }
    const total = weights.reduce((a, b) => a + b, 0);
    recent = r1(
      last.reduce((s, g, i) => s + weights[i] * (0.5 * g.points + 0.5 * g.expected_points), 0) / total,
    );
  } else if (last.length) {
    recent = r1(last.reduce((s, g) => s + g.points, 0) / last.length);
  }

  // How much to trust recent usage over the projection.
  let w = Math.min(0.45, 0.15 * last.length);
  const hot = market.add_rank != null && market.add_rank <= 50 && market.adds_24h >= 5000;
  if (recent != null && input.projectedPpg != null) {
    const gap = recent - input.projectedPpg;
    if (gap > 0 && hot) w += 0.2;
    if (gap > 0 && (news.ramping || news.returned)) w += 0.1;
    if (gap < 0 && market.drop_rank != null && market.drop_rank <= 50) w += 0.15;
  }
  if (news.role_rank === 3 && recent != null && input.projectedPpg != null && recent > input.projectedPpg * 1.8) {
    w -= 0.1; // WR3-type role: a big game is less repeatable
  }
  // QBs, kickers and defenses: weekly scores swing on game script, so a few
  // games say less about the rest of the season.
  w = Math.max(0, Math.min(skill ? 0.75 : 0.25, w));

  let adjusted = input.projectedPpg;
  if (recent != null && input.projectedPpg != null) adjusted = r1((1 - w) * input.projectedPpg + w * recent);
  else if (recent != null) adjusted = recent;

  // notes
  if (games.length && news.returned) {
    notes.push(`Back from injury: ${games.length} game${games.length === 1 ? "" : "s"} played this season (missed ${missed}), so season averages undersell him`);
  }
  const latest = games[games.length - 1];
  if (latest) {
    notes.push(
      `Last game (week ${latest.week}): ${latest.points} pts on ${latest.targets} targets` +
        (latest.carries ? ` and ${latest.carries} carries` : "") +
        (latest.snap_share != null ? `, ${Math.round(latest.snap_share * 100)}% of snaps` : "") +
        (latest.expected_points !== latest.points ? ` (that usage is usually worth ${latest.expected_points})` : ""),
    );
  }
  if (recent != null && input.projectedPpg != null && Math.abs(recent - input.projectedPpg) >= 2) {
    notes.push(
      `Recent usage points to ${recent} a game vs Sleeper's ${input.projectedPpg} projection; weighting recent usage ${Math.round(w * 100)}% → ${adjusted}`,
    );
  }
  if (market.adds_24h >= 1000) {
    notes.push(`${fmtK(market.adds_24h)} Sleeper adds in 24h${market.add_rank ? ` (#${market.add_rank} most added)` : ""}`);
  }
  if (market.drops_24h >= 1000) {
    notes.push(`${fmtK(market.drops_24h)} Sleeper drops in 24h${market.drop_rank ? ` (#${market.drop_rank} most dropped)` : ""}`);
  }
  if (news.route_share != null) notes.push(`Ran a route on ${Math.round(news.route_share * 100)}% of dropbacks (per the news)`);
  if (news.role_rank) notes.push(`News describes him as the No. ${news.role_rank} option`);
  if (news.practice) notes.push(`Practice this week: ${news.practice === "dnp" ? "did not practice" : news.practice}`);

  // reasons to hold
  if (hot) {
    holds.push(`Other managers are chasing him: ${fmtK(market.adds_24h)} adds in 24h (#${market.add_rank} on Sleeper). Once dropped he goes on waivers and likely won't come back`);
  }
  if (skill && latest && recent != null && input.projectedPpg != null && recent >= input.projectedPpg + 3) {
    holds.push(`His recent role (${recent} a game) is well above his projection; projections usually catch up a week or two late`);
  }
  if (news.returned && news.ramping) holds.push("Coming back from injury and expected to get more work as he's eased back in");

  return {
    projected_ppg: input.projectedPpg,
    recent_ppg: recent,
    adjusted_ppg: adjusted,
    recent_weight: r2(w),
    games_played: games.length,
    last_games: games.slice(-4),
    news,
    market,
    notes,
    hold_flags: holds,
  };
}
