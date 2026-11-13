/**
 * Computed views for the Sleeper-style UI: the team screen (with start/sit
 * tips), a player detail sheet, a searchable player index, and playoff odds.
 * Built on the poller's latest feed state, so they're cheap to recompute on
 * every request.
 */

import { sleeperClient } from "../sleeper-client.js";
import { findRosterForUser, type LeagueData } from "../league-data.js";
import { optimalLineup, playerPositions, startingSlots, teamName } from "../season.js";
import { leaguePoints, scheduleOutlook } from "../feeds/analysis.js";
import { adjustFactor } from "../feeds/advisor.js";
import { gamesByTeam, paceOf, statLine, type LiveGame } from "../feeds/live.js";
import type { FeedPoller } from "../feeds/poller.js";
import type { NFLGame, SleeperPlayer, SleeperRoster } from "../types.js";

type State = ReturnType<FeedPoller["state"]>;

const r1 = (n: number) => Math.round(n * 10) / 10;
const RISKY = new Set(["Out", "IR", "Doubtful", "Suspended", "PUP", "NA"]);

export const AVATAR_URL = (id: string | null | undefined) =>
  !id ? null : id.startsWith("http") ? id : `https://sleepercdn.com/avatars/thumbs/${id}`;

/** A manager's team avatar if they set one, else their profile avatar. */
export function userAvatar(user?: { avatar?: string | null; metadata?: unknown } | null): string | null {
  const custom = (user?.metadata as { avatar?: string } | undefined)?.avatar;
  return AVATAR_URL(custom || user?.avatar);
}

function name(p: SleeperPlayer | undefined, id: string) {
  return p ? `${p.first_name} ${p.last_name}`.trim() : id;
}

/** NFL team → bye week (the regular-season week it doesn't play). */
export function teamByes(schedule: NFLGame[]): Map<string, number> {
  const byWeek = new Map<number, Set<string>>();
  for (const g of schedule) {
    const set = byWeek.get(g.week) || new Set<string>();
    set.add(g.home);
    set.add(g.away);
    byWeek.set(g.week, set);
  }
  const all = new Set([...byWeek.values()].flatMap((s) => [...s]));
  const out = new Map<string, number>();
  for (const [week, teams] of byWeek) for (const t of all) if (!teams.has(t)) out.set(t, week);
  return out;
}

/** Adjusted projection for one player in one week. */
function weekProj(st: State, id: string, week: number): number | null {
  const base = st.weekProjections.get(week)?.get(id);
  if (base == null) return null;
  return r1(base * adjustFactor(id, { projections: st.weekProjections, outlooks: st.outlooks } as never));
}

function standingsRank(rosters: SleeperRoster[], rosterId: number): number {
  const sorted = [...rosters].sort(
    (a, b) =>
      (b.settings.wins || 0) - (a.settings.wins || 0) ||
      (b.settings.fpts || 0) + (b.settings.fpts_decimal || 0) / 100 -
        ((a.settings.fpts || 0) + (a.settings.fpts_decimal || 0) / 100),
  );
  return sorted.findIndex((r) => r.roster_id === rosterId) + 1;
}

interface GameInfo {
  start: string | null;
  state: "pre" | "in" | "post" | "bye";
  detail: string;
  opponent: string | null;
  home: boolean;
  fraction_left: number;
}

function gameFor(
  team: string | null | undefined,
  week: number,
  byTeam: Map<string, LiveGame>,
  schedule: NFLGame[],
): GameInfo {
  if (!team) return { start: null, state: "bye", detail: "Free agent", opponent: null, home: false, fraction_left: 0 };
  const live = byTeam.get(team);
  if (live) {
    const home = live.home.team === team;
    return {
      start: live.start,
      state: live.state,
      detail: live.detail,
      opponent: home ? live.away.team : live.home.team,
      home,
      fraction_left: live.fraction_left,
    };
  }
  const g = schedule.find((x) => x.week === week && (x.home === team || x.away === team));
  if (!g) return { start: null, state: "bye", detail: "Bye", opponent: null, home: false, fraction_left: 0 };
  return {
    start: g.date,
    state: g.status === "complete" ? "post" : "pre",
    detail: g.date,
    opponent: g.home === team ? g.away : g.home,
    home: g.home === team,
    fraction_left: g.status === "complete" ? 0 : 1,
  };
}

// ---------- team screen ----------

export interface TeamRow {
  player_id: string | null;
  slot: string;
  name: string;
  position: string | null;
  team: string | null;
  bye: number | null;
  injury_status: string | null;
  game: GameInfo & { difficulty: number | null };
  proj: number | null;
  sleeper_proj: number | null;
  points: number;
  pace: ReturnType<typeof paceOf>;
  stat_line: string;
}

export async function teamView(st: State, rosterId?: number) {
  const data = await st.league();
  const week = data.currentWeek;
  const roster = rosterId
    ? data.rosters.find((r) => r.roster_id === rosterId)
    : findRosterForUser(data.rosters, st.userId);
  if (!roster) throw new Error("Team not found");
  const user = data.users.find((u) => u.user_id === roster.owner_id);
  const matchups = (await sleeperClient.getMatchups(st.leagueId, week)) || [];
  const mine = matchups.find((m) => m.roster_id === roster.roster_id);
  const byTeam = gamesByTeam(st.games);
  const byes = teamByes(data.schedule);
  const slots = startingSlots(data.league.roster_positions);

  const row = (id: string | null, slot: string): TeamRow => {
    if (!id || id === "0") {
      return {
        player_id: null, slot, name: "Empty", position: null, team: null, bye: null, injury_status: null,
        game: { start: null, state: "bye", detail: "", opponent: null, home: false, fraction_left: 0, difficulty: null },
        proj: null, sleeper_proj: null, points: 0, pace: null, stat_line: "",
      };
    }
    const p = data.players.get(id);
    const game = gameFor(p?.team, week, byTeam, data.schedule);
    const difficulty = game.opponent && p?.position ? st.allowed.get(p.position)?.get(game.opponent)?.rank ?? null : null;
    const proj = weekProj(st, id, week);
    const points = mine?.players_points?.[id] ?? 0;
    return {
      player_id: id,
      slot,
      name: name(p, id),
      position: p?.position || null,
      team: p?.team || null,
      bye: p?.team ? byes.get(p.team) ?? null : null,
      injury_status: st.injuries.has(id) ? st.injuries.get(id) || null : p?.injury_status || null,
      game: { ...game, difficulty },
      proj,
      sleeper_proj: st.weekProjections.get(week)?.get(id) ?? null,
      points: r1(points),
      pace: paceOf(points, proj, game.state, game.fraction_left),
      stat_line: statLine(st.liveStats[id], p?.position),
    };
  };

  const starterIds = mine?.starters?.length ? mine.starters : roster.starters || [];
  const starters = slots.map((slot, i) => row(starterIds[i] || null, slot));
  const used = new Set(starterIds);
  const reserve = new Set(roster.reserve || []);
  const taxi = new Set(roster.taxi || []);
  const bench = (roster.players || [])
    .filter((id) => !used.has(id) && !reserve.has(id) && !taxi.has(id))
    .map((id) => row(id, "BN"))
    .sort((a, b) => (b.proj ?? -1) - (a.proj ?? -1));

  // Start/sit: best lineup this week from adjusted projections, among
  // players whose games haven't started.
  const tips: { kind: "swap" | "warn"; text: string; gain?: number; start?: string; sit?: string }[] = [];
  for (const s of starters) {
    if (!s.player_id) tips.push({ kind: "warn", text: `${s.slot} slot is empty` });
    else if (s.game.state === "bye") tips.push({ kind: "warn", text: `${s.name} is on bye this week`, sit: s.player_id });
    else if (s.injury_status && RISKY.has(s.injury_status) && s.game.state === "pre") {
      tips.push({ kind: "warn", text: `${s.name} is listed ${s.injury_status}`, sit: s.player_id });
    }
  }
  const movable = [...starters, ...bench].filter((r) => r.player_id && r.game.state === "pre");
  const locked = starters.filter((r) => r.player_id && r.game.state !== "pre");
  const lockedSlots = new Set(locked.map((r) => r.slot + starters.indexOf(r)));
  const openSlots = data.league.roster_positions.filter((s, i) => !lockedSlots.has(s + i) && slots.includes(s));
  const value = (id: string) => {
    const r = movable.find((x) => x.player_id === id);
    const inj = r?.injury_status && RISKY.has(r.injury_status);
    return inj ? 0 : r?.proj ?? 0;
  };
  const best = optimalLineup(
    movable.map((r) => r.player_id!),
    openSlots,
    value,
    (id) => playerPositions(data.players.get(id)),
  );
  const bestIds = new Set(best.starters.map((s) => s.player_id).filter(Boolean) as string[]);
  const currentMovable = starters.filter((r) => r.player_id && r.game.state === "pre");
  const benched = currentMovable.filter((r) => !bestIds.has(r.player_id!));
  const promoted = bench.filter((r) => r.player_id && bestIds.has(r.player_id));
  const currentTotal = currentMovable.reduce((s, r) => s + value(r.player_id!), 0);
  const gainTotal = r1(best.total - currentTotal);
  if (gainTotal >= 0.5) {
    promoted.forEach((up, i) => {
      const down = benched[i];
      if (!down) return;
      tips.push({
        kind: "swap",
        start: up.player_id!,
        sit: down.player_id!,
        gain: r1(value(up.player_id!) - value(down.player_id!)),
        text: `Start ${up.name} (${up.proj ?? 0} proj) over ${down.name} (${down.proj ?? 0})`,
      });
    });
  }

  const s = roster.settings;
  return {
    week,
    roster_id: roster.roster_id,
    is_you: roster.owner_id === st.userId,
    team_name: teamName(roster, user),
    username: user?.display_name || null,
    avatar: userAvatar(user),
    record: `${s.wins}-${s.losses}${s.ties ? `-${s.ties}` : ""}`,
    rank: standingsRank(data.rosters, roster.roster_id),
    points: r1(mine?.points ?? 0),
    proj_total: r1(starters.reduce((t, r) => t + (r.game.state === "post" ? r.points : r.points + (r.proj ?? 0) * r.game.fraction_left), 0)),
    yet_to_play: starters.filter((r) => r.player_id && r.game.state === "pre").map((r) => r.position),
    lineup_gain: gainTotal >= 0.5 ? gainTotal : 0,
    tips,
    starters,
    bench,
    reserve: [...reserve].map((id) => row(id, "IR")),
    taxi: [...taxi].map((id) => row(id, "TAXI")),
  };
}

// ---------- player index (search + players pane) ----------

export async function playersIndex(st: State) {
  const data = await st.league();
  const week = data.currentWeek;
  const owners = new Map<string, { roster_id: number; team: string }>();
  for (const r of data.rosters) {
    const n = teamName(r, data.users.find((u) => u.user_id === r.owner_id));
    for (const id of r.players || []) owners.set(id, { roster_id: r.roster_id, team: n });
  }
  const mine = findRosterForUser(data.rosters, st.userId);
  const byes = teamByes(data.schedule);
  const byTeam = gamesByTeam(st.games);
  const ids = new Set<string>([...owners.keys(), ...(st.weekProjections.get(week)?.keys() || [])]);
  const through = Math.min(18, (data.league.settings.playoff_week_start || 15) + 2);
  const out = [];
  for (const id of ids) {
    const p = data.players.get(id);
    if (!p || !["QB", "RB", "WR", "TE", "K", "DEF"].includes(p.position)) continue;
    const proj = weekProj(st, id, week);
    if (!owners.has(id) && !proj) continue;
    let ros = 0;
    let games = 0;
    for (let w = week; w <= through; w++) {
      const v = weekProj(st, id, w);
      if (v) {
        ros += v;
        games++;
      }
    }
    const o = st.outlooks.get(id);
    const owner = owners.get(id);
    const game = gameFor(p.team, week, byTeam, data.schedule);
    const last = o?.last_games?.slice(-1)[0];
    out.push({
      player_id: id,
      name: name(p, id),
      position: p.position,
      team: p.team || null,
      bye: p.team ? byes.get(p.team) ?? null : null,
      injury_status: st.injuries.get(id) ?? p.injury_status ?? null,
      owner: owner?.team || null,
      owner_roster_id: owner?.roster_id ?? null,
      is_mine: owner?.roster_id === mine?.roster_id,
      week_proj: proj,
      ros_ppg: games ? r1(ros / games) : null,
      game: { start: game.start, opponent: game.opponent, home: game.home, state: game.state, difficulty: game.opponent ? st.allowed.get(p.position)?.get(game.opponent)?.rank ?? null : null },
      adds: o?.market.adds_24h || 0,
      add_rank: o?.market.add_rank ?? null,
      recent_ppg: o?.recent_ppg ?? null,
      snap: last?.snap_share ?? null,
      targets: last ? last.targets : null,
      season_pts: seasonPoints(st, data, id),
      value: st.values.get(id)?.value || 0,
    });
  }
  return { week, players: out };
}

function seasonPoints(st: State, data: LeagueData, id: string): number {
  let t = 0;
  for (const r of st.weeklyRows) if (r.player_id === id && r.stats?.gms_active) t += leaguePoints(r.stats, data.league.scoring_settings);
  return r1(t);
}

// ---------- player detail sheet ----------

export async function playerView(st: State, id: string) {
  const data = await st.league();
  const p = data.players.get(id);
  if (!p) throw new Error("Unknown player");
  const scoring = data.league.scoring_settings;
  const week = data.currentWeek;
  const playoffStart = data.league.settings.playoff_week_start || 15;
  const through = Math.min(18, playoffStart + 2);
  const owner = data.rosters.find((r) => (r.players || []).includes(id));
  const ownerUser = owner ? data.users.find((u) => u.user_id === owner.owner_id) : undefined;

  const log = st.weeklyRows
    .filter((r) => r.player_id === id)
    .sort((a, b) => a.week - b.week)
    .map((r) => ({
      week: r.week,
      opponent: r.opponent || null,
      played: !!(r.stats?.off_snp || r.stats?.rec_tgt || r.stats?.rush_att || r.stats?.pass_att || (p.position === "K" && r.stats?.fga) || (p.position === "DEF" && r.stats?.gms_active)),
      points: leaguePoints(r.stats || {}, scoring),
      snap_share: r.stats?.tm_off_snp ? Math.round(((r.stats.off_snp || 0) / r.stats.tm_off_snp) * 100) / 100 : null,
      stat_line: statLine(r.stats, p.position),
    }));

  const [outlook] = scheduleOutlook({
    playerIds: [id],
    players: data.players,
    schedule: data.schedule,
    allowed: st.allowed,
    fromWeek: week,
    throughWeek: through,
    playoffStart,
  });
  const o = st.outlooks.get(id);
  return {
    player_id: id,
    name: name(p, id),
    position: p.position,
    team: p.team || null,
    number: (p as { number?: number }).number ?? null,
    age: (p as { age?: number }).age ?? null,
    years_exp: (p as { years_exp?: number }).years_exp ?? null,
    injury_status: st.injuries.get(id) ?? p.injury_status ?? null,
    injury_body_part: (p as { injury_body_part?: string }).injury_body_part ?? null,
    owner: owner ? teamName(owner, ownerUser) : null,
    is_mine: owner?.owner_id === st.userId,
    week,
    week_proj: weekProj(st, id, week),
    sleeper_proj: st.weekProjections.get(week)?.get(id) ?? null,
    outlook: o
      ? {
          projected_ppg: o.projected_ppg,
          recent_ppg: o.recent_ppg,
          adjusted_ppg: o.adjusted_ppg,
          notes: o.notes,
          hold_flags: o.hold_flags,
          quotes: o.news.quotes,
          market: o.market,
        }
      : null,
    usage: st.usage.get(id) || null,
    schedule: outlook?.weeks.map((w) => ({ ...w, proj: weekProj(st, id, w.week) })) || [],
    ros_rank: outlook?.ros_rank ?? null,
    playoff_rank: outlook?.playoff_rank ?? null,
    log,
    news: st.news.filter((n) => n.player_ids.includes(id)).slice(0, 8),
    value: st.values.get(id) || null,
  };
}

// ---------- playoff odds ----------

/** Seeded RNG so the same inputs give the same odds between refreshes. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(rand: () => number) {
  const u = Math.max(rand(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

export interface OddsTeam {
  roster_id: number;
  team_name: string;
  is_you: boolean;
  record: string;
  points_for: number;
  playoff_pct: number;
  bye_pct: number;
  avg_wins: number;
  weekly_proj: number;
}

export function simulateSeason(input: {
  teams: { roster_id: number; wins: number; losses: number; ties: number; pf: number }[];
  /** week → list of [roster A, roster B] pairings still to play. */
  schedule: Map<number, [number, number][]>;
  /** roster_id → week → projected points. */
  projected: Map<number, Map<number, number>>;
  playoffTeams: number;
  byes: number;
  medianGame: boolean;
  sims?: number;
  you?: number;
  firstWeek?: number;
}) {
  const sims = input.sims ?? 10000;
  const rand = rng(12345);
  const ids = input.teams.map((t) => t.roster_id);
  const made = new Map(ids.map((id) => [id, 0]));
  const bye = new Map(ids.map((id) => [id, 0]));
  const wins = new Map(ids.map((id) => [id, 0]));
  let youWinFirst = 0;
  let youWinFirstMade = 0;
  let youLoseFirst = 0;
  let youLoseFirstMade = 0;
  const weeks = [...input.schedule.keys()].sort((a, b) => a - b);
  for (let s = 0; s < sims; s++) {
    const w = new Map(input.teams.map((t) => [t.roster_id, t.wins + t.ties / 2]));
    const pf = new Map(input.teams.map((t) => [t.roster_id, t.pf]));
    let youFirst: boolean | null = null;
    for (const week of weeks) {
      const scores = new Map<number, number>();
      for (const id of ids) {
        const mean = input.projected.get(id)?.get(week) ?? 100;
        scores.set(id, Math.max(0, mean + normal(rand) * (0.15 * mean + 6)));
      }
      for (const [a, b] of input.schedule.get(week) || []) {
        const sa = scores.get(a)!;
        const sb = scores.get(b)!;
        const winner = sa >= sb ? a : b;
        w.set(winner, w.get(winner)! + 1);
        if (input.you != null && week === (input.firstWeek ?? weeks[0]) && (a === input.you || b === input.you)) {
          youFirst = winner === input.you;
        }
      }
      if (input.medianGame) {
        const sorted = [...scores.values()].sort((x, y) => x - y);
        const median = (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.ceil((sorted.length - 1) / 2)]) / 2;
        for (const [id, sc] of scores) if (sc > median) w.set(id, w.get(id)! + 1);
      }
      for (const [id, sc] of scores) pf.set(id, pf.get(id)! + sc);
    }
    const order = [...ids].sort((a, b) => w.get(b)! - w.get(a)! || pf.get(b)! - pf.get(a)!);
    order.forEach((id, i) => {
      if (i < input.playoffTeams) made.set(id, made.get(id)! + 1);
      if (i < input.byes) bye.set(id, bye.get(id)! + 1);
    });
    for (const id of ids) wins.set(id, wins.get(id)! + w.get(id)!);
    if (input.you != null && youFirst != null) {
      const inP = order.indexOf(input.you) < input.playoffTeams;
      if (youFirst) {
        youWinFirst++;
        if (inP) youWinFirstMade++;
      } else {
        youLoseFirst++;
        if (inP) youLoseFirstMade++;
      }
    }
  }
  const pct = (n: number) => Math.round((n / sims) * 1000) / 10;
  return {
    playoff_pct: new Map(ids.map((id) => [id, pct(made.get(id)!)])),
    bye_pct: new Map(ids.map((id) => [id, pct(bye.get(id)!)])),
    avg_wins: new Map(ids.map((id) => [id, r1(wins.get(id)! / sims)])),
    if_win: youWinFirst ? Math.round((youWinFirstMade / youWinFirst) * 1000) / 10 : null,
    if_lose: youLoseFirst ? Math.round((youLoseFirstMade / youLoseFirst) * 1000) / 10 : null,
  };
}

export async function playoffOdds(st: State) {
  const data = await st.league();
  const settings = data.league.settings as { playoff_week_start?: number; playoff_teams?: number; league_average_match?: number };
  const playoffStart = settings.playoff_week_start || 15;
  const playoffTeams = settings.playoff_teams || 6;
  const week = data.currentWeek;
  const lastRegular = playoffStart - 1;
  const mine = findRosterForUser(data.rosters, st.userId);

  // Remaining pairings. The current week counts only if it hasn't been scored.
  const firstWeek = (data.league.settings.last_scored_leg || 0) >= week ? week + 1 : week;
  const schedule = new Map<number, [number, number][]>();
  for (let w = firstWeek; w <= lastRegular; w++) {
    const ms = (await sleeperClient.getMatchups(st.leagueId, w, 60 * 60 * 1000).catch(() => [])) || [];
    const groups = new Map<number, number[]>();
    for (const m of ms) {
      if (m.matchup_id == null) continue;
      groups.set(m.matchup_id, [...(groups.get(m.matchup_id) || []), m.roster_id]);
    }
    schedule.set(w, [...groups.values()].filter((g) => g.length === 2).map((g) => [g[0], g[1]] as [number, number]));
  }

  // Each team's best lineup per week from adjusted projections.
  const projected = new Map<number, Map<number, number>>();
  for (const r of data.rosters) {
    const ids = (r.players || []).filter((id) => !(r.reserve || []).includes(id));
    const byWeek = new Map<number, number>();
    for (let w = firstWeek; w <= lastRegular; w++) {
      byWeek.set(
        w,
        optimalLineup(ids, data.league.roster_positions, (id) => weekProj(st, id, w) ?? 0, (id) => playerPositions(data.players.get(id))).total,
      );
    }
    projected.set(r.roster_id, byWeek);
  }

  const teams = data.rosters.map((r) => ({
    roster_id: r.roster_id,
    wins: r.settings.wins || 0,
    losses: r.settings.losses || 0,
    ties: r.settings.ties || 0,
    pf: (r.settings.fpts || 0) + (r.settings.fpts_decimal || 0) / 100,
  }));
  const sim = simulateSeason({
    teams,
    schedule,
    projected,
    playoffTeams,
    byes: playoffTeams === 6 ? 2 : 0,
    medianGame: settings.league_average_match === 1,
    you: mine?.roster_id,
    firstWeek,
  });
  const rows: OddsTeam[] = data.rosters
    .map((r) => {
      const t = teams.find((x) => x.roster_id === r.roster_id)!;
      const weeks = [...(projected.get(r.roster_id)?.values() || [])];
      return {
        roster_id: r.roster_id,
        team_name: teamName(r, data.users.find((u) => u.user_id === r.owner_id)),
        avatar: userAvatar(data.users.find((u) => u.user_id === r.owner_id)),
        is_you: r.roster_id === mine?.roster_id,
        record: `${t.wins}-${t.losses}${t.ties ? `-${t.ties}` : ""}`,
        points_for: r1(t.pf),
        playoff_pct: sim.playoff_pct.get(r.roster_id)!,
        bye_pct: sim.bye_pct.get(r.roster_id)!,
        avg_wins: sim.avg_wins.get(r.roster_id)!,
        weekly_proj: weeks.length ? r1(weeks.reduce((a, b) => a + b, 0) / weeks.length) : 0,
      };
    })
    .sort((a, b) => b.playoff_pct - a.playoff_pct || b.avg_wins - a.avg_wins);
  return {
    weeks_left: schedule.size,
    first_week: firstWeek,
    last_regular_week: lastRegular,
    playoff_teams: playoffTeams,
    if_win: sim.if_win,
    if_lose: sim.if_lose,
    teams: rows,
  };
}
