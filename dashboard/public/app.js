/**
 * League dashboard, Sleeper-style: league views on the left (Matchup, Team,
 * Waivers, League, Trade, News), a players pane on the right (Available,
 * Trend, Leaders, Activity), and a player sheet for any player you tap.
 *
 * Data: /api/<panel> on load and on a schedule, plus server-sent events from
 * /api/stream for live scores, activity, advice, news and values.
 */

import { h, fmt1, timeAgo } from "./dom.js";
import { refreshInterval, isGameWindow } from "./refresh.js";
import { weeklyChart, positionChart, benchChart } from "./charts.js";

// ---------- state ----------

const S = {
  summary: null,
  team: null,
  live: null,
  matchups: null,
  players: null,
  odds: null,
  standings: null,
  transactions: null,
  advice: null,
  activity: null,
  news: null,
  values: null,
  outlook: null,
  status: null,
  insights: null,
  matchupView: null,
};

const ui = {
  tab: "matchup",
  pane: "available",
  pos: "ALL",
  sort: "week",
  query: "",
  newsFilter: "mine",
  newsKind: "all",
  partner: null,
  giving: new Set(),
  getting: new Set(),
  standingsView: "odds",
  mWeek: null, // matchup week being viewed (null = current)
  mId: null, // matchup id being viewed (null = yours)
};

// ---------- Sleeper links ----------

/** A link into Sleeper (opens the app on a phone that has it). */
function sleeperUrl(section = "") {
  const id = S.summary?.league_id;
  return id ? `https://sleeper.com/leagues/${id}${section ? `/${section}` : ""}` : "https://sleeper.com";
}

function sleeperButton(label, section) {
  return h("a", { class: "sleeper-btn", href: sleeperUrl(section), target: "_blank", rel: "noopener noreferrer", onclick: (e) => e.stopPropagation() }, label);
}

// ---------- small helpers ----------

const r1 = (n) => (n == null ? "–" : (Math.round(n * 10) / 10).toFixed(1));
const pct = (x) => (x == null ? "–" : `${Math.round(x * 100)}%`);
const fmtK = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n || 0));
const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"];
const FLEX = new Set(["RB", "WR", "TE"]);

const logoUrl = (team) => (team ? `https://sleepercdn.com/images/team_logos/nfl/${team.toLowerCase()}.png` : null);
const faceUrl = (id, pos, team) =>
  pos === "DEF" ? logoUrl(team || id) : `https://sleepercdn.com/content/nfl/players/thumb/${id}.jpg`;

function initials(name = "") {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

/** <img> that falls back to initials (or disappears) if it fails to load. */
function img(src, cls, alt = "", fallback = true) {
  if (!src) return fallback ? h("span", { class: `${cls} initials` }, initials(alt)) : null;
  const el = h("img", { src, class: cls, alt, loading: "lazy", decoding: "async" });
  el.addEventListener("error", () => {
    if (fallback) el.replaceWith(h("span", { class: `${cls} initials` }, initials(alt)));
    else el.remove();
  });
  return el;
}

function headshot(p, size = "") {
  if (!p?.player_id) return h("div", { class: `headshot ${size}` }, h("span", { class: "initials" }, "–"));
  const def = p.position === "DEF";
  return h(
    "div",
    { class: `headshot ${size}${def ? " def" : ""}` },
    img(faceUrl(p.player_id, p.position, p.team), "face", p.name),
    !def && p.team ? img(logoUrl(p.team), "logo", "", false) : null,
  );
}

function avatar(src, name, cls = "avatar") {
  return img(src, cls, name);
}

function slotPill(slot) {
  const label = { FLEX: "WRT", WRRB_FLEX: "W/R", REC_FLEX: "W/T", SUPER_FLEX: "SF", BN: "BN", IR: "IR", TAXI: "TX" }[slot] || slot;
  return h("span", { class: `slot ${slot}` }, label);
}

function posTag(pos) {
  return h("span", { class: `c-${pos}` }, h("span", { class: "dot" }), pos);
}

function injuryBadge(status) {
  if (!status) return null;
  const s = status.toLowerCase();
  const label = { questionable: "Q", doubtful: "D", out: "OUT", ir: "IR", suspended: "SUS", pup: "PUP", na: "NA" }[s] || status;
  return h("span", { class: `badge ${s === "questionable" ? "q" : "out"}`, title: status }, label);
}

function oppText(game, position) {
  if (!game?.opponent) return null;
  const rank = game.difficulty;
  const cls = rank == null ? "" : rank <= 10 ? "opp-easy" : rank >= 23 ? "opp-hard" : "";
  return h(
    "span",
    { class: cls || null, title: rank ? `${game.opponent} gives up the ${ordinal(rank)}-most points to ${position}s` : null },
    `${game.home ? "vs" : "@"} ${game.opponent}`,
  );
}

/** "Ja'Marr Chase" → "J. Chase" (team defenses keep their name). */
function shortName(name = "") {
  const parts = name.split(" ");
  if (parts.length < 2) return name;
  const suffix = /^(Jr\.?|Sr\.?|II|III|IV|V)$/i.test(parts.at(-1)) ? parts.pop() : "";
  return `${parts[0][0]}. ${parts.slice(1).join(" ")}${suffix ? ` ${suffix}` : ""}`;
}

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function gameWhen(game) {
  if (!game) return "";
  if (game.state === "bye") return game.detail || "Bye";
  if (game.state === "in") return game.detail;
  if (game.state === "post") return "Final";
  if (!game.start) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(game.start)) {
    return new Date(`${game.start}T12:00:00`).toLocaleDateString([], { weekday: "short" });
  }
  const d = new Date(game.start);
  return `${d.toLocaleDateString([], { weekday: "short" })} ${d
    .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    .replace(" ", "")
    .toLowerCase()}`;
}

function paceArrow(pace) {
  if (pace !== "good" && pace !== "bad") return null;
  return h("span", { class: `pace-arrow ${pace}`, "aria-hidden": "true" }, pace === "good" ? "▲" : "▼");
}

function chips(options, current, onPick, label) {
  return h(
    "div",
    { class: "chips", role: "group", "aria-label": label },
    options.map(([key, text]) =>
      h(
        "button",
        { type: "button", class: "chip", "aria-pressed": String(current === key), onclick: () => onPick(key) },
        text,
      ),
    ),
  );
}

function fill(el, ...kids) {
  el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
}

function sectionHead(title, sub, right) {
  return h(
    "div",
    { class: "section-head" },
    h("h2", {}, title),
    sub ? h("span", { class: "sub" }, sub) : null,
    right ? h("div", { class: "right" }, right) : null,
  );
}

const loading = () => h("p", { class: "state" }, "Loading…");

// ---------- data loading ----------

async function api(name) {
  const res = await fetch(`api/${name}`, { headers: { Accept: "application/json" } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body.data;
}

const errors = {};

async function load(key, name = key) {
  try {
    S[key] = await api(name);
    delete errors[key];
  } catch (error) {
    errors[key] = error.message;
  }
  render();
}

// roster_id → { avatar, record } from the odds table (it has every team)
function teamInfo(rosterId) {
  return S.odds?.teams.find((t) => t.roster_id === rosterId) || null;
}

// ---------- player rows ----------

function teamRow(r, { flash } = {}) {
  if (!r.player_id) {
    return h("div", { class: "prow empty" }, slotPill(r.slot), headshot(null), h("div", { class: "info" }, h("div", { class: "name" }, "Empty")));
  }
  const live = r.game.state === "in";
  const started = r.game.state !== "pre" && r.game.state !== "bye";
  return h(
    "div",
    {
      class: ["prow", live ? "playing" : "", r.pace ? `pace-${r.pace}` : "", flash ? "bump" : ""].join(" ").trim(),
      role: "button",
      tabindex: "0",
      onclick: () => openSheet(r.player_id),
      onkeydown: (e) => e.key === "Enter" && openSheet(r.player_id),
    },
    slotPill(r.slot),
    headshot(r),
    h(
      "div",
      { class: "info" },
      h("div", { class: "name" }, r.name, injuryBadge(r.injury_status), live ? h("span", { class: "badge live" }, "LIVE") : null),
      h(
        "div",
        { class: "line" },
        posTag(r.position),
        ` · ${r.team || "FA"}${r.bye ? ` (${r.bye})` : ""}`,
      ),
      h("div", { class: "line dim" }, gameWhen(r.game), r.game.opponent ? " " : "", oppText(r.game, r.position)),
      r.stat_line ? h("div", { class: "line statline" }, r.stat_line) : null,
    ),
    h(
      "div",
      { class: "score" },
      h("div", { class: `pts pts-${r.pace || "none"}` }, started ? [paceArrow(r.pace), r1(r.points)] : "–"),
      h("div", { class: "proj" }, r.proj == null ? "" : `proj. ${r1(r.proj)}`),
    ),
  );
}

// ---------- HOME (recommendations + analytics) ----------

function tile(label, value, sub, tone) {
  return h("div", { class: "tile" }, h("small", {}, label), h("b", { class: tone || null }, value), sub ? h("span", {}, sub) : null);
}

function recommendations() {
  const recs = [];
  const t = S.team;
  for (const tip of t?.tips || []) {
    recs.push({
      kind: tip.kind === "swap" ? "Lineup" : "Alert",
      tone: tip.kind === "swap" ? "go" : "warn",
      text: tip.text,
      gain: tip.gain ? `+${r1(tip.gain)} pts this week` : null,
      action: sleeperButton("Set lineup", "team"),
      id: tip.start || tip.sit,
    });
  }
  for (const m of (S.advice?.moves || []).slice(0, 3)) {
    recs.push({
      kind: "Waivers",
      tone: "go",
      text: `Add ${m.add.name}, drop ${m.drop.name}${m.cautions?.length ? " (read the caution first)" : ""}`,
      gain: `+${r1(m.ros_gain)} ROS pts`,
      action: sleeperButton("Add", "players"),
      id: m.add.player_id,
    });
  }
  for (const d of (S.advice?.drops || []).filter((x) => x.player.hold_flags?.length).slice(0, 2)) {
    recs.push({ kind: "Hold", tone: "warn", text: `Don't drop ${d.player.name} yet: ${d.player.hold_flags[0]}`, id: d.player.player_id });
  }
  const starters = new Set((t?.starters || []).map((r) => r.player_id));
  const fresh = (S.news?.items || []).filter(
    (n) => n.relevance === "mine" && n.kind === "injury" && Date.now() - Date.parse(n.published) < 48 * 3600 * 1000 && n.player_ids.some((id) => starters.has(id)),
  );
  for (const n of fresh.slice(0, 3)) recs.push({ kind: "Injury", tone: "warn", text: n.title, id: n.player_ids[0] });
  const o = S.odds;
  if (o?.if_win != null && o.if_win - o.if_lose >= 15) {
    recs.push({ kind: "Playoffs", tone: "info", text: `Week ${o.first_week} swings your playoff odds from ${o.if_lose}% to ${o.if_win}%. Start your best lineup.` });
  }
  return recs;
}

function renderHome(el) {
  const ins = S.insights;
  const odds = S.odds;
  const me = odds?.teams.find((t) => t.is_you);
  const st = S.standings?.standings.find((r) => r.is_you);
  const recs = recommendations();
  const pfRank = S.standings ? [...S.standings.standings].sort((a, b) => b.points_for - a.points_for).findIndex((r) => r.is_you) + 1 : null;
  fill(
    el,
    h(
      "div",
      { class: "tiles" },
      tile("Record", me?.record ?? "–", S.team ? `#${S.team.rank} in the league` : null),
      tile("Playoff odds", me ? `${me.playoff_pct}%` : "–", odds?.if_win != null ? `${odds.if_win}% with a win · ${odds.if_lose}% with a loss` : null, me ? (me.playoff_pct >= 50 ? "good" : "bad") : null),
      tile("Points a week", ins?.avg_points != null ? r1(ins.avg_points) : "–", ins ? `League median ${r1(ins.avg_median)}${pfRank ? ` · ${ordinal(pfRank)} in points` : ""}` : null),
      tile("Lineup efficiency", ins?.efficiency != null ? `${ins.efficiency}%` : "–", ins ? `${r1(ins.bench_left_total)} pts left on your bench` : null),
      tile("Luck", st ? `${st.luck > 0 ? "+" : ""}${st.luck.toFixed(1)} W` : "–", st ? `All-play ${st.all_play.wins}-${st.all_play.losses}` : null, st ? (st.luck >= 0 ? "good" : "bad") : null),
    ),
    sectionHead("Do this now", recs.length ? `${recs.length} recommendation${recs.length === 1 ? "" : "s"}` : null),
    recs.length
      ? h(
          "div",
          { class: "recs" },
          recs.map((r) =>
            h(
              "div",
              { class: `rec ${r.tone}`, onclick: r.id ? () => openSheet(r.id) : null, role: r.id ? "button" : null, tabindex: r.id ? "0" : null },
              h("span", { class: "rec-kind" }, r.kind),
              h("span", { class: "rec-text" }, r.text),
              r.gain ? h("span", { class: "rec-gain" }, r.gain) : null,
              r.action || null,
            ),
          ),
        )
      : h("p", { class: "state" }, "Nothing urgent. Your lineup is set and no free agent beats your roster."),
    ins?.weeks?.length
      ? [
          sectionHead("Weekly scores", "You vs the league median"),
          h("div", { class: "card" }, weeklyChart(ins.weeks)),
          sectionHead("Where you win and lose", "Points a week by starting position vs the league average"),
          h("div", { class: "card" }, positionChart(ins.positions)),
          sectionHead("Points left on the bench", ins.losses_bench_would_flip.length ? `Your bench would have won week${ins.losses_bench_would_flip.length > 1 ? "s" : ""} ${ins.losses_bench_would_flip.join(", ")}` : "Best possible lineup minus what you started"),
          h("div", { class: "card" }, benchChart(ins.weeks)),
        ]
      : errors.insights
        ? h("p", { class: "state error" }, errors.insights)
        : loading(),
  );
}

// ---------- MATCHUP ----------

let lastPoints = new Map();

function liveRow(p, side) {
  if (!p) return h("div");
  const key = `${side}:${p.player_id}`;
  const flash = lastPoints.has(key) && lastPoints.get(key) !== p.points;
  const g = p.game;
  const started = g.state === "in" || g.state === "post";
  return h(
    "div",
    {
      class: ["prow", side === "opp" ? "right" : "", g.state === "in" ? "playing" : "", flash ? "bump" : ""].join(" ").trim(),
      onclick: () => openSheet(p.player_id),
    },
    headshot(p, "sm"),
    h(
      "div",
      { class: "info" },
      h("div", { class: "name" }, h("span", { class: "full-name" }, p.name), h("span", { class: "short-name" }, shortName(p.name)), g.has_ball ? h("span", { class: "badge ball", title: "Has the ball" }, "🏈") : null, g.red_zone ? h("span", { class: "badge out" }, "RZ") : null),
      h("div", { class: "line" }, posTag(p.position), ` ${p.team || ""} · ${g.state === "bye" ? "Bye" : g.state === "pre" ? gameWhen({ state: "pre", start: g.start }) || g.detail : g.detail}`, g.opponent ? ` ${g.opponent}` : ""),
      p.stat_line ? h("div", { class: "line statline" }, p.stat_line) : null,
    ),
    h(
      "div",
      { class: "score" },
      h("div", { class: `pts pts-${p.pace || "none"}` }, started ? [paceArrow(p.pace), r1(p.points)] : "–"),
      h("div", { class: "proj" }, g.state === "post" ? "final" : `proj. ${r1(p.projected_final)}`),
    ),
  );
}

function gameCard(g) {
  const team = (side, other) =>
    h(
      "div",
      { class: `gt${g.state !== "pre" && side.score > other.score ? " lead" : ""}` },
      img(logoUrl(side.team), "", "", false),
      h("span", {}, side.team, g.possession === side.team ? " •" : ""),
      h("span", { class: "sc" }, g.state === "pre" ? "" : side.score),
    );
  return h(
    "div",
    { class: `game ${g.state}${g.red_zone ? " redzone" : ""}` },
    team(g.away, g.home),
    team(g.home, g.away),
    h("div", { class: "gd" }, g.state === "pre" ? gameWhen({ state: "pre", start: g.start }) : g.detail, g.down_distance ? ` · ${g.down_distance}` : ""),
    g.last_play ? h("div", { class: "gd", title: g.last_play }, g.last_play) : null,
  );
}

function viewingMyLiveMatchup() {
  const cur = S.summary?.week;
  const myId = S.matchupView?.options?.find((o) => o.is_yours)?.matchup_id;
  return (ui.mWeek == null || ui.mWeek === cur) && (ui.mId == null || ui.mId === myId);
}

async function loadMatchupView() {
  const q = new URLSearchParams();
  if (ui.mWeek != null) q.set("week", ui.mWeek);
  if (ui.mId != null) q.set("id", ui.mId);
  await load("matchupView", `matchup?${q}`);
}

function matchupBar() {
  const v = S.matchupView;
  const cur = S.summary?.week ?? v?.current_week;
  const week = ui.mWeek ?? cur;
  const first = v?.first_week ?? 1;
  const go = (w) => {
    ui.mWeek = w === cur ? null : w;
    ui.mId = null;
    loadMatchupView();
    render();
  };
  return h(
    "div",
    { class: "mu-bar", role: "toolbar", "aria-label": "Choose week and matchup" },
    h("button", { type: "button", class: "icon-btn", disabled: week <= first, "aria-label": "Previous week", onclick: () => go(week - 1) }, "‹"),
    h("span", { class: "wk" }, `Week ${week ?? ""}`),
    h("button", { type: "button", class: "icon-btn", disabled: week >= cur, "aria-label": "Next week", onclick: () => go(week + 1) }, "›"),
    v?.options?.length
      ? h(
          "select",
          {
            class: "chip mu-select",
            "aria-label": "Matchup",
            onchange: (e) => {
              const id = Number(e.target.value);
              ui.mId = v.options.find((o) => o.matchup_id === id)?.is_yours ? null : id;
              loadMatchupView();
              render();
            },
          },
          v.options.map((o) => h("option", { value: o.matchup_id, selected: o.matchup_id === v.matchup_id }, `${o.is_yours ? "★ " : ""}${o.label}`)),
        )
      : null,
    sleeperButton("Open in Sleeper", "matchup"),
  );
}

function renderMatchup(el) {
  const live = viewingMyLiveMatchup();
  const d = live ? S.live : S.matchupView;
  if (!d) return fill(el, errors.live ? h("p", { class: "state error" }, errors.live) : loading(), matchupBar());
  if (!d.me) return fill(el, h("p", { class: "state" }, "No matchup this week."), matchupBar());
  const me = d.me;
  const opp = d.opponent;
  const meInfo = { ...teamInfo(me.roster_id), ...(me.avatar ? { avatar: me.avatar } : {}) };
  const oppInfo = opp ? { ...teamInfo(opp.roster_id), ...(opp.avatar ? { avatar: opp.avatar } : {}) } : null;
  const events = d.events || [];
  const liveGames = d.games || [];
  const win = d.win_probability;
  const side = (s, info, right) =>
    h(
      "div",
      { class: `mu-team${right ? " right" : ""}` },
      avatar(info?.avatar, s.team_name),
      h(
        "div",
        { style: { minWidth: "0" } },
        h("div", { class: "nm", title: s.team_name }, s.team_name),
        h("div", { class: "mu-rec" }, info?.record || ""),
        h("div", { class: `big pts-${s.pace || "none"}` }, paceArrow(s.pace), s.points.toFixed(2)),
        h("div", { class: "projd" }, `proj. ${r1(s.projected_final)}`),
      ),
    );
  const rows = [];
  const n = Math.max(me.starters.length, opp?.starters.length || 0);
  for (let i = 0; i < n; i++) {
    const a = me.starters[i];
    const b = opp?.starters[i];
    rows.push(
      h("div", { class: "mu-row" }, liveRow(a, "me"), h("div", { class: "center" }, slotPill((a || b).slot)), opp ? liveRow(b, "opp") : h("div")),
    );
  }
  const started = liveGames.filter((g) => g.state !== "pre");
  fill(
    el,
    h(
      "div",
      { class: "mu-head" },
      side(me, meInfo, false),
      h(
        "div",
        { class: "mu-mid" },
        win == null
          ? h("div", { class: "muted" }, `Week ${d.week}`)
          : [
              h("div", { class: `pct${win < 0.5 ? " bad" : ""}` }, `${Math.round(win * 100)}%`),
              h("div", { class: "muted", style: { fontSize: "0.74rem" } }, "win chance"),
              h("div", { class: `track${win < 0.5 ? " bad" : ""}`, style: { marginTop: "6px" } }, h("span", { style: { width: `${win * 100}%` } })),
            ],
      ),
      opp ? side(opp, oppInfo, true) : h("div", { class: "mu-team right" }, h("div", { class: "muted" }, "Bye week")),
    ),
    d.final ? h("p", { class: "yet" }, `Final · week ${d.week}`) : null,
    events.length
      ? h(
          "ul",
          { class: "ticker", "aria-label": "Recent scoring" },
          events.slice(0, 6).map((e) =>
            h("li", { class: e.side === "mine" ? "good" : "bad" }, h("span", { class: "d" }, `${e.delta > 0 ? "+" : ""}${e.delta.toFixed(1)}`), e.name, h("span", { class: "muted" }, ` ${e.total.toFixed(1)}`)),
          ),
        )
      : null,
    started.length ? h("div", { class: "games" }, started.map(gameCard)) : null,
    h("div", { class: "mu-rows" }, rows),
    live ? [sectionHead("League scores", `Week ${d.week}`), renderScores()] : null,
    matchupBar(),
  );
  lastPoints = new Map([
    ...me.starters.map((p) => [`me:${p.player_id}`, p.points]),
    ...(opp?.starters || []).map((p) => [`opp:${p.player_id}`, p.points]),
  ]);
}

function renderScores() {
  const m = S.matchups;
  if (!m) return loading();
  return h(
    "div",
    { class: "scores" },
    m.games.map((g) => {
      const top = Math.max(...g.teams.map((t) => t.points));
      const any = g.teams.some((t) => t.points > 0);
      return h(
        "div",
        { class: `score-card${g.teams.some((t) => t.is_you) ? " mine" : ""}` },
        g.teams.map((t) =>
          h(
            "div",
            { class: `t${any && t.points === top ? " lead" : ""}` },
            avatar(t.avatar, t.team_name),
            h("span", { class: "nm", title: t.team_name }, t.team_name),
            t.yet_to_play ? h("span", { class: "left" }, `${t.yet_to_play} left`) : null,
            h("span", { class: "p" }, t.points.toFixed(2)),
          ),
        ),
      );
    }),
  );
}

// ---------- TEAM ----------

let lastTeamPoints = new Map();

function renderTeam(el) {
  const t = S.team;
  if (!t) return fill(el, errors.team ? h("p", { class: "state error" }, errors.team) : loading());
  const win = S.live?.me && S.live.me.roster_id === t.roster_id ? S.live.win_probability : null;
  const counts = {};
  for (const p of t.yet_to_play) counts[p] = (counts[p] || 0) + 1;
  const yet = Object.entries(counts).map(([p, n]) => (n > 1 ? `${n} ${p}` : p));
  const rows = (list) =>
    list.map((r) => {
      const flash = lastTeamPoints.has(r.player_id) && lastTeamPoints.get(r.player_id) !== r.points;
      return teamRow(r, { flash });
    });
  fill(
    el,
    h(
      "div",
      { class: "team-card" },
      avatar(t.avatar, t.team_name),
      h(
        "div",
        { class: "who" },
        h("h2", {}, t.team_name),
        h("div", { class: "handle" }, [t.username ? `@${t.username}` : null, `#${t.rank} (${t.record})`].filter(Boolean).join(" · ")),
        h(
          "div",
          { class: "win-row" },
          win == null ? null : h("span", { class: `pct${win < 0.5 ? " bad" : ""}` }, `${Math.round(win * 100)}% win`),
          h("div", { class: `track${win != null && win < 0.5 ? " bad" : ""}` }, h("span", { style: { width: `${(win ?? 0) * 100}%` } })),
          h("span", { class: "proj" }, `proj. ${r1(t.proj_total)}`),
        ),
      ),
      h("div", { class: "score" }, t.points ? t.points.toFixed(2) : ""),
    ),
    yet.length ? h("p", { class: "yet" }, `Yet to play (${t.yet_to_play.length}): ${yet.join(", ")}`) : null,
    t.tips.length
      ? h(
          "div",
          { class: "tips" },
          h("div", { class: "tips-head" }, h("span", { class: "muted" }, "Lineup changes are made in Sleeper"), sleeperButton("Set lineup in Sleeper", "team")),
          t.tips.map((tip) =>
            h(
              "div",
              { class: `tip ${tip.kind}` },
              h("span", { class: "icon" }, tip.kind === "swap" ? "⇅" : "!"),
              h("span", {}, tip.text),
              tip.gain ? h("span", { class: "gain" }, `+${r1(tip.gain)}`) : null,
            ),
          ),
        )
      : null,
    sectionHead("Starters", `Week ${t.week}`),
    h("div", {}, rows(t.starters)),
    t.bench.length ? [sectionHead("Bench"), h("div", {}, rows(t.bench))] : null,
    t.reserve.length ? [sectionHead("Injured reserve"), h("div", {}, rows(t.reserve))] : null,
    t.taxi.length ? [sectionHead("Taxi"), h("div", {}, rows(t.taxi))] : null,
    renderOutlookTable(),
  );
  lastTeamPoints = new Map([...t.starters, ...t.bench].map((r) => [r.player_id, r.points]));
}

function renderOutlookTable() {
  const d = S.outlook;
  if (!d || !d.players.length) return null;
  const weeks = [];
  for (let w = d.from_week; w <= d.through_week; w++) weeks.push(w);
  const cell = (wk) => {
    if (!wk.opponent) return h("td", { class: "sos muted" }, "BYE");
    const cls = wk.rank == null ? "" : wk.rank <= 8 ? "easy" : wk.rank >= 25 ? "hard" : "";
    return h(
      "td",
      { class: `sos ${cls}`.trim(), title: wk.rank ? `${wk.home ? "vs" : "@"} ${wk.opponent}: allows ${wk.allowed} a game to this position (rank ${wk.rank} of 32, 1 = easiest)` : wk.opponent },
      `${wk.home ? "" : "@"}${wk.opponent}`,
      wk.rank != null ? h("span", { class: "rk" }, wk.rank) : null,
    );
  };
  return [
    sectionHead(
      "Rest of season",
      [d.trade_deadline ? `Trade deadline week ${d.trade_deadline}` : null, `playoffs from week ${d.playoff_start}`].filter(Boolean).join(" · "),
    ),
    h(
      "div",
      { class: "scroll-x" },
      h(
        "table",
        {},
        h(
          "thead",
          {},
          h(
            "tr",
            {},
            h("th", {}, "Player"),
            h("th", { class: "num", title: "Average opponent rank (1 = easiest)" }, "ROS"),
            h("th", { class: "num", title: "Average opponent rank in your playoffs" }, "PO"),
            weeks.map((w) => h("th", { class: `num${w >= d.playoff_start ? " po" : ""}` }, `W${w}`)),
          ),
        ),
        h(
          "tbody",
          {},
          d.players.map((p) =>
            h(
              "tr",
              { class: "click", onclick: () => openSheet(p.player_id) },
              h("td", {}, h("div", { class: "team-cell" }, headshot(p, "sm"), h("div", {}, h("div", { class: "nm" }, p.name), h("div", { class: "sub" }, posTag(p.position), ` · ${p.team || "FA"}`)))),
              h("td", { class: `num ${p.grade === "easy" ? "good" : p.grade === "hard" ? "bad" : ""}` }, fmt1(p.ros_rank)),
              h("td", { class: "num" }, fmt1(p.playoff_rank)),
              p.weeks.map(cell),
            ),
          ),
        ),
      ),
    ),
    h("p", { class: "legend" }, "Opponent rank in fantasy points allowed to the position this season (1 = gives up the most = easiest; 32 = toughest), in your scoring."),
  ];
}

// ---------- WAIVERS ----------

function cardFor(id) {
  return S.players?.players.find((p) => p.player_id === id) || null;
}

function moveSide(tag, c) {
  const info = cardFor(c.player_id) || c;
  return h(
    "div",
    { class: "mv-side", onclick: () => openSheet(c.player_id) },
    h("span", { class: `mv-tag ${tag}` }, tag.toUpperCase()),
    headshot(c, "sm"),
    h(
      "div",
      { style: { minWidth: "0" } },
      h("div", { class: "nm" }, c.name, injuryBadge(c.injury_status), c.on_waivers_until ? h("span", { class: "badge waiver" }, `Waivers until ${new Date(c.on_waivers_until).toLocaleDateString([], { weekday: "short", hour: "numeric" })}`) : null),
      h("div", { class: "line" }, posTag(c.position), ` · ${c.team || "FA"} · ${r1(c.ros_ppg)} pts/g`, info.game?.opponent ? " · " : "", info.game ? oppText(info.game, c.position) : null),
    ),
  );
}

function quotesBlock(c) {
  if (!c.quotes?.length && !c.notes?.length) return null;
  return h(
    "div",
    {},
    h("h4", { style: { margin: "10px 0 4px", fontSize: "0.85rem" } }, c.name),
    c.notes?.length ? h("ul", { class: "reasons" }, c.notes.map((n) => h("li", {}, n))) : null,
    c.quotes?.length ? h("ul", { class: "quotes" }, c.quotes.map((q) => h("li", {}, h("q", {}, q.text), h("span", { class: "muted" }, ` ${q.source}`)))) : null,
  );
}

function renderWaivers(el) {
  const d = S.advice;
  if (!d) return fill(el, errors.advice ? h("p", { class: "state error" }, errors.advice) : loading());
  const last = (n) => n.split(" ").slice(-1)[0];
  fill(
    el,
    sectionHead("Recommended moves", `Weeks ${d.from_week}–${d.through_week} · playoffs from week ${d.playoff_start}`),
    d.moves.length
      ? d.moves.map((m, i) =>
          h(
            "article",
            { class: `move${i === 0 ? " top" : ""}` },
            h(
              "div",
              { class: "mv-head" },
              h("div", { class: "mv-sides" }, moveSide("add", m.add), moveSide("drop", m.drop)),
              h(
                "div",
                { class: "mv-gain" },
                h("b", {}, `+${r1(m.ros_gain)}`),
                h("span", {}, "ROS starting pts"),
                h("span", {}, `Playoffs ${m.playoff_gain >= 0 ? "+" : ""}${r1(m.playoff_gain)} · Wk ${d.from_week} ${m.next_week_gain >= 0 ? "+" : ""}${r1(m.next_week_gain)}`),
              ),
            ),
            h(
              "div",
              { class: "mv-why" },
              h("div", {}, h("h4", {}, `Why add ${last(m.add.name)}`), h("ul", { class: "reasons" }, m.add_reasons.map((r) => h("li", {}, r)))),
              h("div", {}, h("h4", {}, `Why drop ${last(m.drop.name)}`), h("ul", { class: "reasons" }, m.drop_reasons.map((r) => h("li", {}, r)))),
            ),
            m.cautions?.length ? h("div", { class: "caution" }, h("strong", {}, `Before you drop ${m.drop.name}:`), h("ul", {}, m.cautions.map((c) => h("li", {}, c)))) : null,
            h("div", { class: "actions" }, sleeperButton(`Add ${m.add.name} in Sleeper`, "players")),
            h("details", { class: "more" }, h("summary", {}, "What the news and numbers say"), quotesBlock(m.add), quotesBlock(m.drop)),
          ),
        )
      : h("p", { class: "state" }, "No free agent beats anyone on your roster right now."),
    sectionHead("Drop candidates", "Least useful first"),
    h(
      "div",
      { class: "card" },
      d.drops.map((x) =>
        h(
          "div",
          { class: "drop-item" },
          h(
            "div",
            { class: "hd", onclick: () => openSheet(x.player.player_id) },
            h("span", { class: `verdict ${x.verdict}` }, x.verdict),
            headshot(x.player, "sm"),
            h("span", { class: "nm" }, x.player.name, injuryBadge(x.player.injury_status)),
            h("span", { class: "pts" }, `${r1(x.ros_contribution)} pts`),
          ),
          h("ul", { class: "reasons", style: { marginTop: "6px" } }, x.reasons.filter((r) => !r.startsWith("Hold? ")).slice(0, 3).map((r) => h("li", {}, r))),
          x.player.hold_flags?.length ? h("div", { class: "caution" }, h("strong", {}, "Think twice:"), h("ul", {}, x.player.hold_flags.map((f) => h("li", {}, f)))) : null,
        ),
      ),
    ),
    h(
      "p",
      { class: "legend" },
      "Expected points blend Sleeper's projection with each player's recent usage (games actually played), news and Sleeper-wide adds. For every week through your playoffs the advisor builds your best lineup; ROS pts is how much a swap improves it, so byes, injuries and position needs are counted. Points next to drop candidates = starting points your lineups lose without him.",
    ),
  );
}

// ---------- LEAGUE ----------

function renderLeague(el) {
  const o = S.odds;
  const parts = [];
  parts.push(
    sectionHead("Playoff odds", o ? `${o.weeks_left} weeks left · top ${o.playoff_teams} make it` : ""),
  );
  if (!o) parts.push(errors.odds ? h("p", { class: "state error" }, errors.odds) : loading());
  else {
    if (o.if_win != null) {
      const me = o.teams.find((t) => t.is_you);
      parts.push(
        h(
          "div",
          { class: "tip", style: { marginBottom: "12px" } },
          h("span", { class: "icon" }, "%"),
          h("span", {}, `You're at ${me?.playoff_pct ?? "–"}%. Win in week ${o.first_week}: ${o.if_win}% · lose: ${o.if_lose}%`),
          h("span", { class: "gain" }, `${(o.if_win - o.if_lose).toFixed(0)} pt swing`),
        ),
      );
    }
    parts.push(
      h(
        "div",
        { class: "card", style: { padding: "6px 12px" } },
        h(
          "table",
          {},
          h("thead", {}, h("tr", {}, h("th", {}, "Team"), h("th", { class: "num hide-sm" }, "PF"), h("th", { class: "num hide-sm", title: "Projected weekly score, rest of season" }, "Proj/wk"), h("th", { class: "num" }, "Avg W"), h("th", { class: "num" }, "Playoffs"), h("th", { class: "num hide-sm" }, "Bye"))),
          h(
            "tbody",
            {},
            o.teams.map((t) =>
              h(
                "tr",
                { class: t.is_you ? "mine" : null },
                h("td", {}, h("div", { class: "team-cell" }, avatar(t.avatar, t.team_name), h("div", { style: { minWidth: "0" } }, h("div", { class: "nm" }, t.team_name), h("div", { class: "sub" }, t.record)))),
                h("td", { class: "num hide-sm" }, r1(t.points_for)),
                h("td", { class: "num hide-sm" }, r1(t.weekly_proj)),
                h("td", { class: "num" }, r1(t.avg_wins)),
                h("td", { class: "num" }, h("div", { class: "odds-bar" }, h("span", {}, `${t.playoff_pct}%`), h("div", { class: `track hide-sm${t.playoff_pct < 50 ? " bad" : ""}` }, h("span", { style: { width: `${t.playoff_pct}%` } })))),
                h("td", { class: "num hide-sm muted" }, `${t.bye_pct}%`),
              ),
            ),
          ),
        ),
      ),
      h("p", { class: "legend" }, "10,000 simulated seasons from each team's best projected lineup each remaining week (adjusted projections), with real weekly score swings. Ties broken by points for."),
    );
  }

  const st = S.standings;
  parts.push(sectionHead("All-play standings", st ? `Weeks ${st.weeks_counted[0]}–${st.weeks_counted.at(-1)}` : ""));
  if (st) {
    parts.push(
      h(
        "div",
        { class: "card", style: { padding: "6px 12px" } },
        h(
          "table",
          {},
          h("thead", {}, h("tr", {}, h("th", {}, "#"), h("th", {}, "Team"), h("th", { class: "num" }, "Record"), h("th", { class: "num" }, "All-play"), h("th", { class: "num", title: "Actual wins minus wins your scores earned" }, "Luck"), h("th", { class: "num hide-sm" }, "PF"))),
          h(
            "tbody",
            {},
            st.standings.map((r) =>
              h(
                "tr",
                { class: r.is_you ? "mine" : null },
                h("td", { class: "muted" }, r.actual_rank),
                h("td", {}, h("div", { class: "team-cell" }, avatar(teamInfo(r.roster_id)?.avatar, r.team_name), h("span", { class: "nm" }, r.team_name))),
                h("td", { class: "num" }, `${r.actual.wins}-${r.actual.losses}`),
                h("td", { class: "num" }, `${r.all_play.wins}-${r.all_play.losses}`),
                h("td", { class: `num ${r.luck > 0.25 ? "good" : r.luck < -0.25 ? "bad" : "muted"}` }, `${r.luck > 0 ? "+" : ""}${r.luck.toFixed(2)}`),
                h("td", { class: "num hide-sm" }, r.points_for.toFixed(1)),
              ),
            ),
          ),
        ),
      ),
    );
  } else parts.push(loading());

  const tx = S.transactions;
  parts.push(sectionHead("Recent moves", tx ? `Since week ${tx.since_week}` : ""));
  if (tx) {
    parts.push(
      h(
        "div",
        { class: "card", style: { padding: "4px 16px" } },
        tx.items.slice(0, 20).map((i) =>
          h(
            "div",
            { class: "news-item" },
            h(
              "div",
              { class: "body" },
              h("span", { class: `kind ${i.type === "trade" ? "kind-role" : "kind-general"}` }, { trade: "Trade", waiver: "Waiver", free_agent: "Free agent" }[i.type] || i.type),
              h("span", {}, i.summary),
              h("div", { class: "meta" }, `Week ${i.week} · ${timeAgo(i.date)}`),
            ),
          ),
        ),
      ),
    );
  }
  fill(el, parts);
}

// ---------- TRADE ----------

function renderTrade(el) {
  const d = S.values;
  if (!d) return fill(el, errors.values ? h("p", { class: "state error" }, errors.values) : loading());
  const mine = d.teams.find((t) => t.is_you);
  const others = d.teams.filter((t) => !t.is_you);
  if (!mine) return fill(el, h("p", { class: "state" }, "You are not in this league."));
  if (!ui.partner || !others.some((t) => t.roster_id === ui.partner)) ui.partner = others[0]?.roster_id;
  const partner = others.find((t) => t.roster_id === ui.partner);
  const sum = (team, set) => team.players.filter((p) => set.has(p.player_id)).reduce((s, p) => s + p.value, 0);
  const give = sum(mine, ui.giving);
  const get = partner ? sum(partner, ui.getting) : 0;
  const diff = get - give;
  const base = Math.max(give, get, 1);
  const even = Math.abs(diff) / base < 0.05;
  const list = (team, set) =>
    h(
      "ul",
      { class: "trade-list" },
      team.players
        .filter((p) => p.value > 0)
        .map((p) =>
          h(
            "li",
            {},
            h(
              "label",
              {},
              h("input", {
                type: "checkbox",
                checked: set.has(p.player_id),
                onchange: (e) => {
                  if (e.target.checked) set.add(p.player_id);
                  else set.delete(p.player_id);
                  render();
                },
              }),
              headshot(p, "sm"),
              h("span", { class: "nm" }, p.name, h("div", { class: "line", style: { fontSize: "0.72rem", fontWeight: "400" } }, posTag(p.position), ` ${p.position_rank ? `#${p.position_rank}` : ""} · ${p.team || "FA"}`)),
              h("span", { class: "val" }, p.value.toLocaleString(), p.trend_30d ? h("span", { class: p.trend_30d > 0 ? "good" : "bad" }, p.trend_30d > 0 ? " ▲" : " ▼") : null),
            ),
          ),
        ),
    );
  const select = h(
    "select",
    {
      class: "chip",
      "aria-label": "Trade partner",
      onchange: (e) => {
        ui.partner = Number(e.target.value);
        ui.getting.clear();
        render();
      },
    },
    others.map((t) => h("option", { value: t.roster_id, selected: t.roster_id === ui.partner }, t.team_name)),
  );
  const rank = d.teams.findIndex((t) => t.is_you) + 1;
  fill(
    el,
    sectionHead("Trade calculator", `${d.source} values · your roster ranks ${rank} of ${d.teams.length}`, select),
    h(
      "div",
      { class: `verdict-box ${!give && !get ? "" : even ? "" : diff > 0 ? "good" : "bad"}`, role: "status" },
      h("strong", {}, !give && !get ? "Tick players on both sides to compare a trade." : even ? "Even trade" : diff > 0 ? `You win by ${diff.toLocaleString()} (${Math.round((diff / base) * 100)}%)` : `You lose by ${(-diff).toLocaleString()} (${Math.round((-diff / base) * 100)}%)`),
      give || get ? h("div", { class: "muted", style: { fontSize: "0.82rem" } }, `You give ${give.toLocaleString()} · you get ${get.toLocaleString()}`) : null,
    ),
    h(
      "div",
      { class: "trade-cols" },
      h("div", { class: "card" }, h("h3", { style: { marginBottom: "6px" } }, "You give"), list(mine, ui.giving)),
      partner ? h("div", { class: "card" }, h("h3", { style: { marginBottom: "6px" } }, `${partner.team_name} gives`), list(partner, ui.getting)) : null,
    ),
    h("p", { class: "legend" }, "Crowd-sourced redraft values from FantasyCalc in your league's format. Adding values up flatters 2-for-1 offers: the side getting the single best player usually wins those."),
  );
}

// ---------- NEWS ----------

const KIND = { returning: "Returning", injury: "Injury", role: "Role", transaction: "Move", general: "News" };

function renderNews(el) {
  const d = S.news;
  if (!d) return fill(el, errors.news ? h("p", { class: "state error" }, errors.news) : loading());
  const items = d.items.filter(
    (n) => (ui.newsFilter === "all" || n.relevance === ui.newsFilter) && (ui.newsKind === "all" || n.kind === ui.newsKind),
  );
  fill(
    el,
    sectionHead("Player news"),
    chips(
      [["mine", `My players ${d.counts.mine}`], ["league", `League ${d.counts.league}`], ["free_agent", `Free agents ${d.counts.free_agent}`], ["all", "All"]],
      ui.newsFilter,
      (k) => {
        ui.newsFilter = k;
        render();
      },
      "Whose news",
    ),
    h("div", { style: { height: "8px" } }),
    chips(
      [["all", "Any type"], ["returning", "Returning"], ["injury", "Injury"], ["role", "Role"], ["transaction", "Moves"]],
      ui.newsKind,
      (k) => {
        ui.newsKind = k;
        render();
      },
      "News type",
    ),
    items.length
      ? items.slice(0, 50).map((n) => {
          const p = n.players[0];
          return h(
            "div",
            { class: "news-item" },
            p ? h("div", { onclick: () => openSheet(p.player_id), style: { cursor: "pointer" } }, headshot(p, "sm")) : null,
            h(
              "div",
              { class: "body" },
              h("span", { class: `kind kind-${n.kind}` }, KIND[n.kind] || n.kind),
              h("a", { href: n.url, target: "_blank", rel: "noopener noreferrer" }, n.title),
              n.summary ? h("p", {}, n.summary) : null,
              h(
                "div",
                { class: "meta" },
                [n.source, timeAgo(n.published), ...n.players.map((x) => `${x.name}${x.owner ? ` · ${x.owner}` : " · free agent"}`)].join(" · "),
              ),
            ),
          );
        })
      : h("p", { class: "state" }, "Nothing matches."),
  );
}

// ---------- players pane ----------

const adviceFor = (id) => S.advice?.moves.find((m) => m.add.player_id === id);

function playerCard(p, rank, mode) {
  const fp = mode === "ros" ? p.ros_ppg : mode === "leaders" ? p.season_pts : p.week_proj;
  const label = mode === "ros" ? "ROS/G" : mode === "leaders" ? "SEASON" : "PROJ";
  const move = !p.owner ? adviceFor(p.player_id) : null;
  return h(
    "div",
    { class: "pcard", role: "button", tabindex: "0", onclick: () => openSheet(p.player_id), onkeydown: (e) => e.key === "Enter" && openSheet(p.player_id) },
    h(
      "div",
      { class: "top" },
      h("span", { class: "rank" }, rank),
      headshot(p),
      h(
        "div",
        { class: "info" },
        h("div", { class: "name" }, p.name, injuryBadge(p.injury_status)),
        h("div", { class: "line" }, posTag(p.position), ` · ${p.team || "FA"}${p.bye ? ` (${p.bye})` : ""}`, p.owner ? h("span", { class: "owner-tag" }, ` · ${p.is_mine ? "Your team" : p.owner}`) : null),
        h("div", { class: "line" }, gameWhen(p.game), p.game?.opponent ? " " : "", oppText(p.game, p.position)),
      ),
      h("div", { class: "fpts" }, h("b", {}, r1(fp)), h("span", {}, label)),
    ),
    h(
      "div",
      { class: "strip" },
      [
        ["ROS/G", r1(p.ros_ppg)],
        ["L3", r1(p.recent_ppg)],
        ["SNAP", pct(p.snap)],
        ["TGT", p.targets ?? "–"],
        ["ADDS", p.adds ? fmtK(p.adds) : "–"],
        ["SEASON", r1(p.season_pts)],
      ].map(([k, v]) => h("div", {}, h("small", {}, k), h("b", {}, v))),
    ),
    move ? h("div", { class: "why" }, `Advisor: +${r1(move.ros_gain)} ROS pts if you drop ${move.drop.name}`) : null,
  );
}

function renderPane() {
  const filters = document.getElementById("pane-filters");
  const body = document.getElementById("pane-body");
  for (const b of document.querySelectorAll("[data-pane]")) b.setAttribute("aria-selected", String(b.dataset.pane === ui.pane));

  if (ui.pane === "activity") {
    fill(filters, h("div", { class: "row" }, h("h3", {}, "Your players"), h("span", { class: "muted", style: { fontSize: "0.8rem" } }, S.activity?.live ? "Live" : "Plays and news")));
    const items = S.activity?.items || [];
    fill(
      body,
      items.length
        ? h(
            "ul",
            { class: "act" },
            items.slice(0, 50).map((a) =>
              h(
                "li",
                { class: [a.kind, a.scoring ? "scoring" : ""].join(" "), onclick: () => openSheet(a.player_id) },
                headshot(a, "sm"),
                h(
                  "div",
                  { class: "body" },
                  h("div", { class: "hd" }, a.name, " ", h("span", { class: "what" }, a.kind === "news" ? "News" : a.headline)),
                  h("div", { class: "dt" }, a.kind === "news" ? a.headline : a.detail),
                ),
                h("span", { class: "when" }, a.clock || timeAgo(a.at)),
              ),
            ),
          )
        : h("p", { class: "state" }, "Nothing yet. Plays appear here as soon as your players' games start."),
    );
    return;
  }

  const all = S.players?.players || [];
  const q = ui.query.trim().toLowerCase();
  const posOk = (p) => ui.pos === "ALL" || (ui.pos === "FLEX" ? FLEX.has(p.position) : p.position === ui.pos);
  let list;
  let mode = ui.sort;
  let title = "Available";
  if (q) {
    title = "Search";
    list = all.filter((p) => p.name.toLowerCase().includes(q) && posOk(p)).sort((a, b) => (b.week_proj ?? 0) - (a.week_proj ?? 0));
  } else if (ui.pane === "trend") {
    title = "Trending adds";
    mode = "week";
    list = all.filter((p) => !p.owner && p.adds > 0 && posOk(p)).sort((a, b) => b.adds - a.adds);
  } else if (ui.pane === "leaders") {
    title = "Leaders";
    mode = "leaders";
    list = all.filter(posOk).sort((a, b) => b.season_pts - a.season_pts);
  } else {
    list = all
      .filter((p) => !p.owner && posOk(p))
      .sort((a, b) => (ui.sort === "ros" ? (b.ros_ppg ?? 0) - (a.ros_ppg ?? 0) : (b.week_proj ?? 0) - (a.week_proj ?? 0)));
  }
  const sortSelect =
    ui.pane === "available" && !q
      ? h(
          "select",
          {
            class: "chip",
            "aria-label": "Sort by",
            onchange: (e) => {
              ui.sort = e.target.value;
              renderPane();
            },
          },
          h("option", { value: "week", selected: ui.sort === "week" }, `Week ${S.players?.week ?? ""} projection`),
          h("option", { value: "ros", selected: ui.sort === "ros" }, "Rest of season"),
        )
      : null;
  fill(
    filters,
    h("div", { class: "row" }, h("h3", {}, title), sortSelect),
    chips(
      ["ALL", ...POSITIONS, "FLEX"].map((p) => [p, p]),
      ui.pos,
      (k) => {
        ui.pos = k;
        renderPane();
      },
      "Position",
    ),
  );
  if (!S.players) return fill(body, errors.players ? h("p", { class: "state error" }, errors.players) : loading());
  fill(body, list.length ? list.slice(0, 60).map((p, i) => playerCard(p, i + 1, mode)) : h("p", { class: "state" }, "No players match."));
}

// ---------- player sheet ----------

let sheetEls = null;
let lastFocus = null;

function closeSheet() {
  if (!sheetEls) return;
  sheetEls.forEach((e) => e.remove());
  sheetEls = null;
  lastFocus?.focus?.();
}

async function openSheet(id) {
  if (!id) return;
  closeSheet();
  lastFocus = document.activeElement;
  const backdrop = h("div", { class: "sheet-backdrop", onclick: closeSheet });
  const close = h("button", { type: "button", class: "icon-btn sheet-close", onclick: closeSheet }, "Close");
  const panel = h("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": "Player details" }, close, loading());
  sheetEls = [backdrop, panel];
  document.body.append(backdrop, panel);
  close.focus();
  let p;
  try {
    p = await api(`player?id=${encodeURIComponent(id)}`);
  } catch (error) {
    fill(panel, close, h("p", { class: "state error" }, error.message));
    return;
  }
  if (!sheetEls || sheetEls[1] !== panel) return;
  const o = p.outlook;
  const kpi = (label, value, sub) => h("div", { class: "kpi" }, h("b", {}, value), h("small", {}, label), sub ? h("div", { class: "muted", style: { fontSize: "0.68rem" } }, sub) : null);
  fill(
    panel,
    close,
    h(
      "div",
      { class: "sheet-hero" },
      headshot(p, "lg"),
      h(
        "div",
        {},
        h("h2", {}, p.name, injuryBadge(p.injury_status)),
        h("div", { class: "line" }, posTag(p.position), ` · ${p.team || "FA"}${p.number ? ` #${p.number}` : ""}${p.age ? ` · Age ${p.age}` : ""}${p.years_exp != null ? ` · Yr ${p.years_exp + 1}` : ""}`),
        h("div", { class: "line" }, p.is_mine ? "On your team" : p.owner ? `Rostered by ${p.owner}` : "Free agent", p.injury_body_part ? ` · ${p.injury_body_part}` : ""),
        h("div", { style: { marginTop: "8px" } }, sleeperButton(p.is_mine ? "Open my team in Sleeper" : p.owner ? "Trade in Sleeper" : "Add in Sleeper", p.is_mine ? "team" : p.owner ? "trades" : "players")),
      ),
    ),
    h(
      "div",
      { class: "kpis" },
      kpi(`Week ${p.week} proj`, r1(p.week_proj), p.sleeper_proj != null ? `Sleeper ${r1(p.sleeper_proj)}` : null),
      kpi("Expected / game", r1(o?.adjusted_ppg), o?.projected_ppg != null ? `Sleeper ${r1(o.projected_ppg)}` : null),
      kpi("Recent / game", r1(o?.recent_ppg), "games played"),
      kpi("Trade value", p.value ? p.value.value.toLocaleString() : "–", p.value?.position_rank ? `${p.position}${p.value.position_rank}` : null),
    ),
    o?.hold_flags?.length ? h("div", { class: "caution" }, h("strong", {}, "Think twice before dropping:"), h("ul", {}, o.hold_flags.map((f) => h("li", {}, f)))) : null,
    o?.notes?.length ? [h("h3", {}, "Outlook"), h("ul", { class: "reasons" }, o.notes.map((n) => h("li", {}, n)))] : null,
    o?.quotes?.length ? [h("h3", {}, "What the news says"), h("ul", { class: "quotes" }, o.quotes.map((q) => h("li", {}, h("q", {}, q.text), h("span", { class: "muted" }, ` ${q.source}, ${timeAgo(q.date)}`))))] : null,
    p.schedule.length
      ? [
          h("h3", {}, `Schedule${p.playoff_rank ? ` · playoff matchups avg ${r1(p.playoff_rank)} of 32` : ""}`),
          h(
            "div",
            { class: "sched" },
            p.schedule.map((w) =>
              h(
                "div",
                { class: [w.rank == null ? "" : w.rank <= 8 ? "easy" : w.rank >= 25 ? "hard" : "", w.playoffs ? "po" : ""].join(" ").trim() || null, title: w.rank ? `Rank ${w.rank} of 32 (1 = easiest)` : null },
                h("small", {}, `W${w.week}`),
                w.opponent ? `${w.home ? "" : "@"}${w.opponent}` : "BYE",
                h("small", {}, w.proj != null ? r1(w.proj) : ""),
              ),
            ),
          ),
        ]
      : null,
    p.log.length
      ? [
          h("h3", {}, "Game log"),
          h(
            "div",
            { class: "scroll-x" },
            h(
              "table",
              {},
              h("thead", {}, h("tr", {}, h("th", {}, "Wk"), h("th", {}, "Opp"), h("th", { class: "num" }, "Pts"), h("th", { class: "num" }, "Snap"), h("th", {}, "Stats"))),
              h(
                "tbody",
                {},
                [...p.log].reverse().map((g) =>
                  h(
                    "tr",
                    {},
                    h("td", {}, g.week),
                    h("td", { class: "muted" }, g.opponent || "–"),
                    h("td", { class: "num" }, g.played ? r1(g.points) : "–"),
                    h("td", { class: "num muted" }, g.played ? pct(g.snap_share) : "–"),
                    h("td", { class: g.played ? "" : "muted", style: { fontSize: "0.8rem" } }, g.played ? g.stat_line || "–" : "Did not play"),
                  ),
                ),
              ),
            ),
          ),
        ]
      : null,
    p.news.length
      ? [
          h("h3", {}, "News"),
          p.news.map((n) =>
            h(
              "div",
              { class: "news-item" },
              h(
                "div",
                { class: "body" },
                h("span", { class: `kind kind-${n.kind}` }, KIND[n.kind] || n.kind),
                h("a", { href: n.url, target: "_blank", rel: "noopener noreferrer" }, n.title),
                n.summary ? h("p", {}, n.summary) : null,
                h("div", { class: "meta" }, `${n.source} · ${timeAgo(n.published)}`),
              ),
            ),
          ),
        ]
      : null,
  );
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeSheet();
});

// ---------- header, activity bar, status ----------

function renderHeader() {
  const s = S.summary;
  if (s) document.getElementById("open-sleeper").href = sleeperUrl();
  if (s) {
    document.getElementById("league-name").textContent = s.league;
    document.title = `${s.league} · Week ${s.week}`;
    const av = document.getElementById("league-avatar");
    if (s.avatar && av.hidden) {
      av.src = s.avatar;
      av.hidden = false;
      av.addEventListener("error", () => (av.hidden = true), { once: true });
    }
  }
  const status = document.getElementById("status");
  const mode = S.status?.mode;
  status.classList.toggle("live", mode === "fast" || mode === "game_day" || isGameWindow());
  status.textContent =
    mode === "fast"
      ? `Live · every ${S.status.live_poll_seconds}s`
      : mode === "game_day"
        ? "Games on"
        : lastRefresh
          ? `Updated ${new Date(lastRefresh).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
          : "";

  const bar = document.getElementById("activity-bar");
  const text = document.getElementById("activity-text");
  const a = S.activity?.items?.[0];
  bar.classList.toggle("live", !!S.activity?.live);
  if (a) {
    fill(text, h("strong", {}, a.name), " ", a.kind === "news" ? a.headline : `${a.headline}${a.clock ? ` · ${a.clock}` : ""}`, h("span", { class: "muted" }, ` · ${timeAgo(a.at)}`));
  } else text.textContent = "No plays or news for your players yet.";

  if (S.status) {
    document.getElementById("feeds-mode").textContent = `· ${{ fast: "live", game_day: "game day", idle: "idle" }[S.status.mode] || ""}`;
    fill(
      document.getElementById("feeds-list"),
      S.status.feeds.map((f) =>
        h(
          "li",
          {},
          h("span", {}, f.name),
          h("span", { class: f.error ? "bad" : "" }, f.error ? `error: ${f.error}` : `every ${f.every_seconds < 60 ? `${f.every_seconds}s` : `${Math.round(f.every_seconds / 60)} min`} · ${f.last_ok ? timeAgo(f.last_ok) : "pending"}`),
        ),
      ),
    );
  }
}

// ---------- render + tabs ----------

const VIEWS = { home: renderHome, matchup: renderMatchup, team: renderTeam, waivers: renderWaivers, league: renderLeague, trade: renderTrade, news: renderNews };
const TABS = [...Object.keys(VIEWS), "players"];

let renderQueued = false;
function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderHeader();
    const view = document.querySelector(`[data-view="${ui.tab}"]`);
    if (view && VIEWS[ui.tab]) {
      try {
        VIEWS[ui.tab](view);
      } catch (error) {
        console.error(error);
        fill(view, h("p", { class: "state error" }, `Couldn't show this: ${error.message}`));
      }
    }
    try {
      renderPane();
    } catch (error) {
      console.error(error);
    }
  });
}

function showTab(name) {
  if (!TABS.includes(name)) name = "home";
  ui.tab = name;
  document.getElementById("app").classList.toggle("show-pane", name === "players");
  for (const b of document.querySelectorAll("[data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === name));
  for (const v of document.querySelectorAll("[data-view]")) v.hidden = v.dataset.view !== name;
  if (location.hash !== `#${name}`) history.replaceState(null, "", `#${name}`);
  render();
}

for (const b of document.querySelectorAll("[data-tab]")) b.addEventListener("click", () => showTab(b.dataset.tab));
for (const b of document.querySelectorAll("[data-pane]")) {
  b.addEventListener("click", () => {
    ui.pane = b.dataset.pane;
    renderPane();
  });
}
window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));

const search = document.getElementById("search");
let searchTimer;
search.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    ui.query = search.value;
    renderPane();
  }, 120);
});

const activityBar = document.getElementById("activity-bar");
const openActivity = () => {
  ui.pane = "activity";
  if (window.matchMedia("(max-width: 1100px)").matches) showTab("players");
  else renderPane();
};
activityBar.addEventListener("click", openActivity);
activityBar.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && openActivity());

// ---------- refresh loop + live stream ----------

let lastRefresh = 0;
let timer;
const refreshBtn = document.getElementById("refresh");

async function refreshAll() {
  refreshBtn.disabled = true;
  await Promise.all([
    load("summary"),
    load("team"),
    load("matchups"),
    load("players"),
    load("odds"),
    load("standings"),
    load("transactions"),
    load("insights"),
    loadMatchupView(),
    ...["live", "activity", "advice", "news", "values", "outlook"].map((k) => load(k)),
  ]);
  refreshBtn.disabled = false;
  lastRefresh = Date.now();
  clearTimeout(timer);
  timer = setTimeout(() => (document.visibilityState === "visible" ? refreshAll() : null), refreshInterval());
  render();
}
refreshBtn.addEventListener("click", refreshAll);

let stream = null;
let lastLiveRefetch = 0;
const TOPICS = ["live", "activity", "advice", "news", "values", "outlook", "status"];

function openStream() {
  if (stream || !("EventSource" in window)) return;
  stream = new EventSource("api/stream");
  for (const topic of TOPICS) {
    stream.addEventListener(topic, (event) => {
      try {
        S[topic] = JSON.parse(event.data).data;
      } catch {
        return;
      }
      if (topic === "live" && Date.now() - lastLiveRefetch > (S.live?.mode === "fast" ? 15000 : 60000)) {
        lastLiveRefetch = Date.now();
        load("team");
        load("matchups");
        if (!viewingMyLiveMatchup() && (ui.mWeek == null || ui.mWeek === S.summary?.week)) loadMatchupView();
      }
      if (topic === "advice") load("players");
      render();
    });
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    openStream();
    if (Date.now() - lastRefresh > refreshInterval()) refreshAll();
  } else {
    stream?.close();
    stream = null;
  }
});

showTab(location.hash.slice(1));
refreshAll();
openStream();
