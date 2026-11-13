/**
 * Background feed poller for the dashboard. Each feed runs on its own timer
 * and picks its next interval from the game state:
 *
 *   fast      one of YOUR players is in a game right now
 *   game day  some NFL game is live, or kicks off within 15 minutes
 *   idle      everything else
 *
 * Results are kept in memory (news also on disk) and pushed to open browser
 * tabs as server-sent events. A feed that fails backs off (doubling, up to 15
 * minutes) and keeps its last good data.
 */

import { EventEmitter } from "events";
import { promises as fs } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { sleeperClient } from "../sleeper-client.js";
import { loadLeagueData, findRosterForUser, type LeagueData } from "../league-data.js";
import { startingSlots, teamName } from "../season.js";
import { fetchJson, fetchText } from "./http.js";
import {
  anyPlaying,
  gamesByTeam,
  liveSide,
  parseScoreboard,
  scoreEvents,
  winProbability,
  type LiveGame,
  type LiveSide,
  type ScoreEvent,
} from "./live.js";
import {
  buildPlayerIndex,
  mergeNews,
  parseEspnNews,
  parseRotowireNews,
  tagNews,
  type NewsItem,
  type PlayerIndex,
} from "./news.js";
import {
  fantasyCalcParams,
  pointsAllowed,
  projectionMap,
  riserScore,
  scheduleOutlook,
  tradeValues,
  usageTrends,
  type FantasyCalcRow,
  type TradeValue,
  type WeeklyRow,
} from "./analysis.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, "..", "..", ".cache");
const NEWS_FILE = join(CACHE_DIR, "news.json");

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

const URLS = {
  scoreboard: (season: string, week: number, regular: boolean) =>
    regular
      ? `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2&week=${week}&dates=${season}`
      : "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard",
  espnNews: "https://site.api.espn.com/apis/site/v2/sports/football/nfl/news?limit=50",
  rotowire: "https://www.rotowire.com/rss/news.php?sport=NFL",
  liveStats: (season: string, week: number) =>
    `https://api.sleeper.app/v1/stats/nfl/regular/${season}/${week}`,
  projections: (season: string, week: number) =>
    `https://api.sleeper.app/v1/projections/nfl/regular/${season}/${week}`,
  weekStats: (season: string, week: number) =>
    `https://api.sleeper.app/stats/nfl/${season}/${week}?season_type=regular` +
    ["QB", "RB", "WR", "TE", "K", "DEF"].map((p) => `&position[]=${p}`).join(""),
  fantasyCalc: (params: string) => `https://api.fantasycalc.com/values/current?${params}`,
};

export type Mode = "fast" | "game_day" | "idle";
export type Topic = "live" | "news" | "usage" | "outlook" | "values" | "status";

export interface Snapshot {
  data: unknown;
  updated: string;
}

interface Job {
  name: string;
  run: () => Promise<void>;
  interval: () => number;
  timer?: NodeJS.Timeout;
  failures: number;
  last_ok?: string;
  last_error?: string;
  next_at?: number;
  running?: boolean;
}

export interface PollerOptions {
  leagueId: string;
  userId: string;
  livePollMs: number;
}

export class FeedPoller extends EventEmitter {
  private readonly opts: PollerOptions;
  private readonly jobs = new Map<string, Job>();
  private readonly snapshots = new Map<Topic, Snapshot & { json: string }>();
  private stopped = true;
  viewers = 0;

  // raw state shared between jobs
  private games: LiveGame[] = [];
  private liveStats: Record<string, Record<string, number>> = {};
  private projections = new Map<string, number>();
  private projectionWeek = 0;
  private news: NewsItem[] = [];
  private index?: { index: PlayerIndex; size: number };
  private lastSides: { me: LiveSide | null; opp: LiveSide | null; week: number } = {
    me: null,
    opp: null,
    week: 0,
  };
  private events: ScoreEvent[] = [];
  private values = new Map<string, TradeValue>();

  constructor(opts: PollerOptions) {
    super();
    this.setMaxListeners(100);
    this.opts = opts;
  }

  // ---------- mode ----------

  private myPlayerIds(data: LeagueData): string[] {
    return findRosterForUser(data.rosters, this.opts.userId)?.players || [];
  }

  private cachedLeague?: LeagueData;

  private async league(): Promise<LeagueData> {
    this.cachedLeague = await loadLeagueData(this.opts.leagueId);
    return this.cachedLeague;
  }

  mode(): Mode {
    const data = this.cachedLeague;
    const byTeam = gamesByTeam(this.games);
    if (data && anyPlaying(this.myPlayerIds(data), data.players, byTeam)) return "fast";
    const soon = Date.now() + 15 * MIN;
    if (
      this.games.some(
        (g) => g.state === "in" || (g.state === "pre" && Date.parse(g.start) <= soon && Date.parse(g.start) > Date.now() - 4 * HOUR),
      )
    ) {
      return "game_day";
    }
    return "idle";
  }

  /** Is today an NFL game day (any game today, Eastern)? Drives news cadence. */
  private gameToday(): boolean {
    const day = (d: Date) =>
      d.toLocaleDateString("en-US", { timeZone: "America/New_York" });
    const today = day(new Date());
    return this.games.some((g) => day(new Date(g.start)) === today);
  }

  // ---------- jobs ----------

  private define(name: string, interval: () => number, run: () => Promise<void>) {
    this.jobs.set(name, { name, interval, run, failures: 0 });
  }

  private setupJobs() {
    const fast = () => this.mode() === "fast";
    const live = () => this.mode() !== "idle";
    const watched = () => this.viewers > 0;

    // Game clock, possession, red zone. Big response (~250 KB), so it only
    // runs every 5 s while someone has the page open.
    this.define(
      "scoreboard",
      () => (fast() ? (watched() ? 5 * SEC : 30 * SEC) : live() ? 30 * SEC : 10 * MIN),
      async () => {
        const data = await this.league();
        const regular = data.nflState.season_type === "regular";
        this.games = parseScoreboard(
          await fetchJson(URLS.scoreboard(data.league.season, data.currentWeek, regular)),
        );
        await this.publishLive();
      },
    );

    // League scores in your scoring: small and cheap, so this is the
    // every-couple-of-seconds feed during your games.
    this.define(
      "matchups",
      () => (fast() ? this.opts.livePollMs : live() ? MIN : 10 * MIN),
      () => this.publishLive(true),
    );

    // Stat lines for players in games (Sleeper; only active players are listed).
    this.define(
      "live-stats",
      () => (fast() ? (watched() ? 5 * SEC : 30 * SEC) : live() ? MIN : 30 * MIN),
      async () => {
        const data = await this.league();
        this.liveStats =
          (await fetchJson<Record<string, Record<string, number>>>(
            URLS.liveStats(data.league.season, data.currentWeek),
          )) || {};
        await this.publishLive();
      },
    );

    this.define("projections", () => 30 * MIN, async () => {
      const data = await this.league();
      const raw = await fetchJson<Record<string, Record<string, number>>>(
        URLS.projections(data.league.season, data.currentWeek),
      );
      this.projections = projectionMap(raw || {}, data.league.scoring_settings);
      this.projectionWeek = data.currentWeek;
      await this.publishLive();
    });

    // Breaking news. Inactives and practice reports matter most on game days.
    this.define(
      "news",
      () => (live() || this.gameToday() ? 2 * MIN : 5 * MIN),
      async () => {
        const data = await this.league();
        const index = this.playerIndex(data);
        const results = await Promise.allSettled([
          fetchText(URLS.rotowire).then((xml) => parseRotowireNews(xml, index)),
          fetchJson<{ articles?: [] }>(URLS.espnNews).then((j) => parseEspnNews(j, index)),
        ]);
        const fresh = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
        const errors = results
          .filter((r): r is PromiseRejectedResult => r.status === "rejected")
          .map((r) => String(r.reason?.message || r.reason));
        if (!fresh.length && errors.length) throw new Error(errors.join("; "));
        const before = this.news.length ? this.news[0].id : "";
        this.news = mergeNews(this.news, fresh);
        if (this.news[0]?.id !== before || this.news.length !== fresh.length) {
          await this.saveNews();
        }
        this.publishNews(data);
      },
    );

    // Usage trends and points allowed: weekly stats for every played week.
    // Finished weeks are cached on disk, so this mostly refetches last week.
    this.define("weekly-stats", () => 6 * HOUR, async () => {
      const data = await this.league();
      const rows = await this.loadWeeklyStats(data);
      this.publishUsageAndOutlook(data, rows);
    });

    this.define("values", () => 6 * HOUR, async () => {
      const data = await this.league();
      const rows = await fetchJson<FantasyCalcRow[]>(
        URLS.fantasyCalc(fantasyCalcParams(data.league, data.rosters.length)),
      );
      this.values = tradeValues(rows || []);
      this.publishValues(data);
    });
  }

  private schedule(job: Job, delay: number) {
    if (this.stopped) return;
    clearTimeout(job.timer);
    job.next_at = Date.now() + delay;
    job.timer = setTimeout(() => this.runJob(job), delay);
  }

  private async runJob(job: Job) {
    if (this.stopped || job.running) return;
    job.running = true;
    try {
      await job.run();
      job.failures = 0;
      job.last_ok = new Date().toISOString();
      job.last_error = undefined;
    } catch (error) {
      job.failures++;
      job.last_error = error instanceof Error ? error.message : String(error);
      if (job.failures === 1 || job.failures % 10 === 0) {
        console.error(`[feeds] ${job.name} failed (${job.failures}x): ${job.last_error}`);
      }
    } finally {
      job.running = false;
    }
    const base = job.interval();
    const backoff = job.failures ? Math.min(15 * MIN, base * 2 ** job.failures) : base;
    this.schedule(job, backoff);
    this.publishStatus();
  }

  /** Mode changed (game started, viewer arrived): pull fast feeds forward. */
  nudge() {
    for (const job of this.jobs.values()) {
      const wanted = Date.now() + job.interval();
      if (!job.failures && job.next_at && job.next_at > wanted) this.schedule(job, job.interval());
    }
  }

  async start() {
    this.stopped = false;
    await this.loadNews();
    this.setupJobs();
    let delay = 0;
    for (const job of this.jobs.values()) {
      this.schedule(job, delay);
      delay += 250; // stagger first runs
    }
  }

  stop() {
    this.stopped = true;
    for (const job of this.jobs.values()) clearTimeout(job.timer);
  }

  addViewer(): () => void {
    this.viewers++;
    this.nudge();
    return () => {
      this.viewers = Math.max(0, this.viewers - 1);
    };
  }

  // ---------- snapshots ----------

  private publish(topic: Topic, data: unknown) {
    const json = JSON.stringify(data);
    if (this.snapshots.get(topic)?.json === json) return;
    const snap = { data, updated: new Date().toISOString(), json };
    this.snapshots.set(topic, snap);
    this.emit("update", topic, { data, updated: snap.updated });
  }

  snapshot(topic: Topic): Snapshot | undefined {
    const s = this.snapshots.get(topic);
    return s ? { data: s.data, updated: s.updated } : undefined;
  }

  /** Wait (up to timeoutMs) for a topic's first data. */
  async waitFor(topic: Topic, timeoutMs = 20 * SEC): Promise<Snapshot> {
    const now = this.snapshot(topic);
    if (now) return now;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off("update", onUpdate);
        const job = [...this.jobs.values()].find((j) => j.last_error);
        reject(new Error(job?.last_error || `${topic} is still loading`));
      }, timeoutMs);
      const onUpdate = (t: Topic, snap: Snapshot) => {
        if (t !== topic) return;
        clearTimeout(timer);
        this.off("update", onUpdate);
        resolve(snap);
      };
      this.on("update", onUpdate);
    });
  }

  allSnapshots(): [Topic, Snapshot][] {
    return [...this.snapshots.entries()].map(([t, s]) => [t, { data: s.data, updated: s.updated }]);
  }

  private publishStatus() {
    const mode = this.mode();
    this.publish("status", {
      mode,
      viewers: this.viewers > 0,
      live_poll_seconds: this.opts.livePollMs / 1000,
      feeds: [...this.jobs.values()].map((j) => ({
        name: j.name,
        every_seconds: Math.round(j.interval() / 1000),
        last_ok: j.last_ok || null,
        error: j.last_error || null,
      })),
    });
  }

  // ---------- live ----------

  private liveBusy = false;

  private async publishLive(fetchMatchups = false) {
    if (this.liveBusy && !fetchMatchups) return;
    this.liveBusy = true;
    try {
      const data = await this.league();
      const week = data.currentWeek;
      const matchups =
        (await sleeperClient.getMatchups(this.opts.leagueId, week, fetchMatchups ? 0 : undefined)) || [];
      const mine = findRosterForUser(data.rosters, this.opts.userId);
      const meM = matchups.find((m) => m.roster_id === mine?.roster_id);
      const oppM = meM
        ? matchups.find((m) => m.matchup_id === meM.matchup_id && m.roster_id !== meM.roster_id)
        : undefined;
      const byTeam = gamesByTeam(this.games);
      const slots = startingSlots(data.league.roster_positions);
      const proj = this.projectionWeek === week ? this.projections : new Map<string, number>();
      const name = (rosterId: number) => {
        const r = data.rosters.find((x) => x.roster_id === rosterId);
        return r ? teamName(r, data.users.find((u) => u.user_id === r.owner_id)) : `Team ${rosterId}`;
      };
      const build = (m: typeof meM) =>
        m
          ? liveSide({
              matchup: m,
              teamName: name(m.roster_id),
              slots,
              players: data.players,
              byTeam,
              projections: proj,
              stats: this.liveStats,
            })
          : null;
      const me = build(meM);
      const opp = build(oppM);

      if (this.lastSides.week !== week) {
        this.events = [];
        this.lastSides = { me: null, opp: null, week };
      }
      const now = new Date().toISOString();
      const fresh = [
        ...(me ? scoreEvents(this.lastSides.me, me, "mine", now) : []),
        ...(opp ? scoreEvents(this.lastSides.opp, opp, "opponent", now) : []),
      ];
      if (fresh.length) this.events = [...fresh, ...this.events].slice(0, 40);
      this.lastSides = { me, opp, week };

      const teams = new Set(
        [...(me?.starters || []), ...(opp?.starters || [])].map((s) => s.team).filter(Boolean),
      );
      const order = { in: 0, pre: 1, post: 2 } as const;
      const games = this.games
        .filter((g) => teams.has(g.home.team) || teams.has(g.away.team))
        .sort((a, b) => order[a.state] - order[b.state] || a.start.localeCompare(b.start));
      const prevMode = (this.snapshot("status")?.data as { mode?: Mode } | undefined)?.mode;
      const mode = this.mode();

      this.publish("live", {
        week,
        mode,
        live_poll_seconds: mode === "fast" ? this.opts.livePollMs / 1000 : null,
        has_projections: proj.size > 0,
        me,
        opponent: opp,
        win_probability: me && opp ? winProbability(me, opp) : null,
        games,
        events: this.events,
      });
      if (prevMode && prevMode !== mode) {
        this.publishStatus();
        this.nudge();
      }
    } finally {
      this.liveBusy = false;
    }
  }

  // ---------- news ----------

  private playerIndex(data: LeagueData): PlayerIndex {
    if (!this.index || this.index.size !== data.players.size) {
      this.index = { index: buildPlayerIndex(data.players), size: data.players.size };
    }
    return this.index.index;
  }

  private owners(data: LeagueData): Map<string, string> {
    const owners = new Map<string, string>();
    for (const r of data.rosters) {
      const n = teamName(r, data.users.find((u) => u.user_id === r.owner_id));
      for (const id of r.players || []) owners.set(id, n);
    }
    return owners;
  }

  private publishNews(data: LeagueData) {
    const tagged = tagNews(this.news, {
      mine: new Set(this.myPlayerIds(data)),
      owners: this.owners(data),
      players: data.players,
    });
    this.publish("news", {
      items: tagged.slice(0, 200),
      counts: {
        mine: tagged.filter((n) => n.relevance === "mine").length,
        league: tagged.filter((n) => n.relevance === "league").length,
        free_agent: tagged.filter((n) => n.relevance === "free_agent").length,
      },
      sources: ["Rotowire", "ESPN"],
    });
  }

  private async loadNews() {
    try {
      this.news = JSON.parse(await fs.readFile(NEWS_FILE, "utf-8"));
    } catch {
      this.news = [];
    }
  }

  private async saveNews() {
    try {
      await fs.mkdir(CACHE_DIR, { recursive: true });
      await fs.writeFile(NEWS_FILE, JSON.stringify(this.news));
    } catch (error) {
      console.error("[feeds] could not save news:", error instanceof Error ? error.message : error);
    }
  }

  // ---------- weekly stats: usage + schedule strength ----------

  private async loadWeeklyStats(data: LeagueData): Promise<WeeklyRow[]> {
    const season = data.league.season;
    const lastDone = data.weeks.at(-1)?.week ?? data.currentWeek - 1;
    const rows: WeeklyRow[] = [];
    for (let week = data.league.settings.start_week || 1; week <= lastDone; week++) {
      const file = join(CACHE_DIR, `stats-${season}-w${week}.json`);
      let weekRows: WeeklyRow[] | null = null;
      try {
        const stat = await fs.stat(file);
        // the latest finished week can still get stat corrections for a day or two
        if (week < lastDone || Date.now() - stat.mtimeMs < 24 * HOUR) {
          weekRows = JSON.parse(await fs.readFile(file, "utf-8"));
        }
      } catch {
        // not cached yet
      }
      if (!weekRows) {
        const raw = await fetchJson<(WeeklyRow & { stats: Record<string, number> })[]>(
          URLS.weekStats(season, week),
        );
        weekRows = (raw || []).map((r) => ({
          player_id: String(r.player_id),
          week,
          team: r.team ?? null,
          opponent: r.opponent ?? null,
          stats: r.stats || {},
        }));
        await fs.mkdir(CACHE_DIR, { recursive: true });
        await fs.writeFile(file, JSON.stringify(weekRows));
      }
      rows.push(...weekRows);
    }
    return rows;
  }

  private publishUsageAndOutlook(data: LeagueData, rows: WeeklyRow[]) {
    const scoring = data.league.scoring_settings;
    const mineIds = this.myPlayerIds(data);
    const mine = new Set(mineIds);
    const owners = this.owners(data);
    const trends = usageTrends(rows, data.players, scoring);
    const tag = (t: (typeof trends)[number]) => ({
      ...t,
      score: Math.round(riserScore(t) * 10) / 10,
      owner: owners.get(t.player_id) || null,
      weeks: t.weeks.slice(-6),
    });
    const freeAgentRisers = trends
      .filter((t) => !owners.has(t.player_id) && riserScore(t) >= 2 && t.recent.opportunities >= 4)
      .sort((a, b) => riserScore(b) - riserScore(a))
      .slice(0, 12)
      .map(tag);
    const myTrends = trends
      .filter((t) => mine.has(t.player_id))
      .sort((a, b) => riserScore(b) - riserScore(a))
      .map(tag);
    const leagueRisers = trends
      .filter((t) => owners.has(t.player_id) && !mine.has(t.player_id) && riserScore(t) >= 3)
      .sort((a, b) => riserScore(b) - riserScore(a))
      .slice(0, 10)
      .map(tag);
    const weeksUsed = [...new Set(rows.map((r) => r.week))].sort((a, b) => a - b);
    this.publish("usage", {
      weeks: weeksUsed,
      free_agents: freeAgentRisers,
      mine: myTrends,
      league: leagueRisers,
    });

    // schedule strength
    const allowed = pointsAllowed(rows, data.players, scoring);
    const playoffStart = data.league.settings.playoff_week_start || 15;
    const throughWeek = Math.min(18, playoffStart + 2);
    const fromWeek = Math.min(throughWeek, data.currentWeek);
    const outlook = scheduleOutlook({
      playerIds: mineIds,
      players: data.players,
      schedule: data.schedule,
      allowed,
      fromWeek,
      throughWeek,
      playoffStart,
    }).sort((a, b) => (a.ros_rank ?? 99) - (b.ros_rank ?? 99));
    const deadline = (data.league.settings as { trade_deadline?: number }).trade_deadline;
    this.publish("outlook", {
      from_week: fromWeek,
      through_week: throughWeek,
      playoff_start: playoffStart,
      trade_deadline: deadline && deadline < 99 ? deadline : null,
      weeks_of_data: weeksUsed.length,
      players: outlook,
    });
  }

  // ---------- trade values ----------

  private publishValues(data: LeagueData) {
    const teams = data.rosters.map((r) => {
      const players = (r.players || [])
        .map((id) => {
          const p = data.players.get(id);
          const v = this.values.get(id);
          return {
            player_id: id,
            name: p ? `${p.first_name} ${p.last_name}`.trim() : id,
            position: p?.position || null,
            team: p?.team || null,
            value: v?.value ?? 0,
            position_rank: v?.position_rank ?? null,
            trend_30d: v?.trend_30d ?? 0,
          };
        })
        .sort((a, b) => b.value - a.value);
      return {
        roster_id: r.roster_id,
        team_name: teamName(r, data.users.find((u) => u.user_id === r.owner_id)),
        is_you: r.owner_id === this.opts.userId,
        total: players.reduce((s, p) => s + p.value, 0),
        players,
      };
    });
    const rostered = new Set(data.rosters.flatMap((r) => r.players || []));
    const topFreeAgents = [...this.values.entries()]
      .filter(([id]) => !rostered.has(id))
      .sort((a, b) => b[1].value - a[1].value)
      .slice(0, 10)
      .map(([id, v]) => {
        const p = data.players.get(id);
        return {
          player_id: id,
          name: p ? `${p.first_name} ${p.last_name}`.trim() : id,
          position: p?.position || null,
          team: p?.team || null,
          value: v.value,
          position_rank: v.position_rank,
          trend_30d: v.trend_30d,
        };
      });
    this.publish("values", {
      source: "FantasyCalc",
      format: fantasyCalcParams(data.league, data.rosters.length),
      teams: teams.sort((a, b) => b.total - a.total),
      free_agents: topFreeAgents,
    });
  }
}
