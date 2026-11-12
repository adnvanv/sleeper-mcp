import { isGameWindow, refreshInterval } from "./refresh.js";

// ---------- DOM helpers (never innerHTML: team names are user input) ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === "class") el.className = value;
    // CSP forbids inline style attributes; CSSOM assignment is allowed
    else if (key === "style") Object.assign(el.style, value);
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(
      child instanceof Node ? child : document.createTextNode(String(child)),
    );
  }
  return el;
}

const fmt1 = (n) => (n == null ? "–" : Number(n).toFixed(1));
const fmtSigned = (n) => (n > 0 ? `+${n.toFixed(2)}` : n.toFixed(2));
const fmtCount = (n) =>
  n >= 1e6
    ? `${(n / 1e6).toFixed(1)}M`
    : n >= 1e3
      ? `${Math.round(n / 1e3)}K`
      : String(n);
const record = (r) => `${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ""}`;

function timeAgo(iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

function injuryBadge(status, onBye) {
  const badges = [];
  if (onBye) badges.push(h("span", { class: "badge bye" }, "BYE"));
  if (!status) return badges;
  const s = status.toLowerCase();
  const cls = s === "questionable" ? "q" : "out";
  const label =
    {
      questionable: "Q",
      doubtful: "D",
      out: "OUT",
      ir: "IR",
      suspended: "SUS",
      pup: "PUP",
    }[s] || status;
  badges.push(h("span", { class: `badge ${cls}`, title: status }, label));
  return badges;
}

// ---------- Panels ----------

function panelEls(name) {
  const section = document.querySelector(`[data-panel="${name}"]`);
  return {
    section,
    body: section.querySelector("[data-body]"),
    note: section.querySelector("[data-note]"),
  };
}

const renderers = {
  matchups(data, { body, note }) {
    note.textContent = `Week ${data.week}`;
    if (!data.games.length) {
      body.replaceChildren(
        h("p", { class: "state" }, "No matchups this week."),
      );
      return;
    }
    const cards = data.games.map((game) => {
      const top = Math.max(...game.teams.map((t) => t.points));
      const anyPoints = game.teams.some((t) => t.points > 0);
      const mine = game.teams.some((t) => t.is_you);
      return h(
        "div",
        { class: `matchup${mine ? " mine" : ""}` },
        game.teams.map((t) =>
          h(
            "div",
            { class: `side${anyPoints && t.points === top ? " leading" : ""}` },
            h(
              "span",
              { class: "team", title: t.team_name },
              t.team_name,
              t.is_you ? h("span", { class: "you-tag" }, "You") : null,
            ),
            h(
              "span",
              {},
              h("span", { class: "pts" }, t.points.toFixed(2)),
              t.yet_to_play
                ? h("span", { class: "left" }, `${t.yet_to_play} to play`)
                : null,
            ),
          ),
        ),
      );
    });
    body.replaceChildren(h("div", { class: "matchups" }, cards));
  },

  roster(data, { body, note }) {
    note.textContent = `${data.team_name} · ${data.points.toFixed(2)} pts`;
    const warnings = data.starters.filter((p) => p.warning);
    const row = (p) =>
      h(
        "tr",
        {},
        h("td", { class: "slot" }, p.slot),
        h(
          "td",
          {},
          h(
            "div",
            { class: "player" },
            h("span", {}, p.name, injuryBadge(p.injury_status, p.on_bye)),
            p.position
              ? h(
                  "span",
                  { class: "sub" },
                  [p.position, p.team || "FA", p.nfl_opponent]
                    .filter(Boolean)
                    .join(" · "),
                )
              : null,
          ),
        ),
        h("td", { class: "num" }, p.player_id ? p.points.toFixed(1) : "–"),
        h("td", { class: "num muted" }, fmt1(p.season_ppg)),
      );
    const group = (label, players) =>
      players.length
        ? [
            h("tr", { class: "group" }, h("td", { colspan: 4 }, label)),
            ...players.map(row),
          ]
        : [];

    body.replaceChildren(
      ...warnings.map((w) =>
        h(
          "div",
          { class: "warning", role: "status" },
          `${w.slot}: ${w.name} – ${w.warning}`,
        ),
      ),
      h(
        "table",
        {},
        h(
          "thead",
          {},
          h(
            "tr",
            {},
            h("th", {}, "Slot"),
            h("th", {}, "Player"),
            h("th", { class: "num" }, "Pts"),
            h("th", { class: "num", title: "Season points per game" }, "PPG"),
          ),
        ),
        h(
          "tbody",
          {},
          group("Starters", data.starters),
          group("Bench", data.bench),
          group("Injured reserve", data.reserve),
          group("Taxi", data.taxi),
        ),
      ),
    );
  },

  standings(data, { body, note }) {
    const w = data.weeks_counted;
    note.textContent = w.length
      ? `Weeks ${w[0]}–${w.at(-1)}`
      : "No scored weeks yet";
    const columns = [
      { key: "actual_rank", label: "#", num: true, get: (r) => r.actual_rank },
      { key: "team", label: "Team", get: (r) => r.team_name.toLowerCase() },
      {
        key: "actual",
        label: "Record",
        num: true,
        get: (r) => r.actual.win_pct,
      },
      {
        key: "all_play",
        label: "All-play",
        num: true,
        get: (r) => r.all_play.win_pct,
      },
      { key: "luck", label: "Luck", num: true, get: (r) => r.luck },
      {
        key: "pf",
        label: "PF",
        num: true,
        hideSm: true,
        get: (r) => r.points_for,
      },
    ];
    let sort = standingsSort;

    const draw = () => {
      const col = columns.find((c) => c.key === sort.key) || columns[0];
      const rows = [...data.standings].sort((a, b) => {
        const x = col.get(a);
        const y = col.get(b);
        const cmp = x < y ? -1 : x > y ? 1 : 0;
        return sort.dir === "asc" ? cmp : -cmp;
      });
      const head = h(
        "tr",
        {},
        columns.map((c) =>
          h(
            "th",
            {
              class:
                [c.num ? "num" : "", c.hideSm ? "hide-sm" : ""]
                  .join(" ")
                  .trim() || null,
              scope: "col",
            },
            h(
              "button",
              {
                type: "button",
                "aria-sort":
                  c.key === sort.key
                    ? sort.dir === "asc"
                      ? "ascending"
                      : "descending"
                    : null,
                onclick: () => {
                  const firstDir =
                    c.key === "actual_rank" || c.key === "team"
                      ? "asc"
                      : "desc";
                  sort =
                    sort.key === c.key
                      ? { key: c.key, dir: sort.dir === "asc" ? "desc" : "asc" }
                      : { key: c.key, dir: firstDir };
                  standingsSort = sort;
                  draw();
                },
              },
              c.label,
            ),
          ),
        ),
      );
      const bodyRows = rows.map((r) =>
        h(
          "tr",
          { class: r.is_you ? "mine" : null },
          h("td", { class: "num muted" }, r.actual_rank),
          h(
            "td",
            {},
            h(
              "div",
              { class: "player" },
              h("span", {}, r.team_name),
              h(
                "span",
                { class: "sub hide-sm" },
                `All-play rank ${r.all_play_rank} · ${r.owner}`,
              ),
            ),
          ),
          h("td", { class: "num" }, record(r.actual)),
          h(
            "td",
            { class: "num bar-cell" },
            h(
              "div",
              {
                class: "bar",
                title: `${record(r.all_play)} (${(r.all_play.win_pct * 100).toFixed(1)}%)`,
              },
              h("span", {}, record(r.all_play)),
              h(
                "span",
                { class: "bar-track", "aria-hidden": "true" },
                h("span", {
                  class: "bar-fill",
                  style: { width: `${(r.all_play.win_pct * 100).toFixed(1)}%` },
                }),
              ),
            ),
          ),
          h(
            "td",
            {
              class: `num ${r.luck > 0.25 ? "pos" : r.luck < -0.25 ? "neg" : "muted"}`,
            },
            fmtSigned(r.luck),
          ),
          h("td", { class: "num hide-sm" }, r.points_for.toFixed(1)),
        ),
      );
      body.replaceChildren(
        h("table", {}, h("thead", {}, head), h("tbody", {}, bodyRows)),
        h(
          "p",
          { class: "legend" },
          "All-play: record if every team played every other team each week. ",
          "Luck: actual wins minus the wins your scores earned (positive = lucky).",
          data.median_game ? " Record includes median games." : "",
        ),
      );
    };
    draw();
  },

  "free-agents"(data, { body, note }) {
    note.textContent = `${data.rostered_skipped} of top ${data.checked} adds are taken`;
    if (!data.free_agents.length) {
      body.replaceChildren(
        h("p", { class: "state" }, "No trending free agents right now."),
      );
      return;
    }
    body.replaceChildren(
      h(
        "ul",
        { class: "list" },
        data.free_agents.map((p) =>
          h(
            "li",
            {},
            h(
              "div",
              { class: "player" },
              h("span", {}, p.name, injuryBadge(p.injury_status, false)),
              h("span", { class: "sub" }, `${p.position} · ${p.team || "FA"}`),
            ),
            h(
              "span",
              { class: "adds", title: `${p.trending_adds} adds in 24h` },
              `${fmtCount(p.trending_adds)} adds`,
            ),
          ),
        ),
      ),
    );
  },

  transactions(data, { body, section }) {
    const filters = section.querySelector("[data-filters]");
    const kinds = [
      ["all", "All"],
      ["trade", "Trades"],
      ["waiver", "Waivers"],
      ["free_agent", "Free agents"],
    ];
    const draw = () => {
      filters.replaceChildren(
        ...kinds.map(([kind, label]) =>
          h(
            "button",
            {
              type: "button",
              class: "chip",
              "aria-pressed": String(feedFilter === kind),
              onclick: () => {
                feedFilter = kind;
                draw();
              },
            },
            kind === "all" ? label : `${label} ${data.counts[kind] || 0}`,
          ),
        ),
      );
      const items = data.items.filter(
        (i) => feedFilter === "all" || i.type === feedFilter,
      );
      body.replaceChildren(
        items.length
          ? h(
              "ul",
              { class: "list feed" },
              items.map((i) =>
                h(
                  "li",
                  {},
                  h(
                    "span",
                    { class: `type ${i.type}` },
                    {
                      trade: "Trade",
                      waiver: "Waiver",
                      free_agent: "Free agent",
                    }[i.type] || i.type,
                  ),
                  h("span", {}, i.summary),
                  h(
                    "span",
                    { class: "when", title: new Date(i.date).toLocaleString() },
                    `Wk ${i.week} · ${timeAgo(i.date)}`,
                  ),
                ),
              ),
            )
          : h(
              "p",
              { class: "state" },
              `No moves since week ${data.since_week}.`,
            ),
      );
    };
    draw();
  },
};

let standingsSort = { key: "actual_rank", dir: "asc" };
let feedFilter = "all";

// ---------- Loading ----------

async function fetchPanel(name) {
  const res = await fetch(`api/${name}`, {
    headers: { Accept: "application/json" },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body.data;
}

async function loadPanel(name) {
  const els = panelEls(name);
  if (!els.body.childElementCount) {
    els.body.replaceChildren(h("p", { class: "state" }, "Loading…"));
  }
  try {
    renderers[name](await fetchPanel(name), els);
  } catch (error) {
    els.body.replaceChildren(
      h(
        "p",
        { class: "state error" },
        `Couldn't load: ${error.message}`,
        h(
          "button",
          { type: "button", class: "btn", onclick: () => loadPanel(name) },
          "Retry",
        ),
      ),
    );
  }
}

async function loadSummary() {
  try {
    const s = await fetchPanel("summary");
    document.getElementById("league-name").textContent = s.league;
    const phase =
      s.season_type === "regular"
        ? s.playoff_week_start && s.week >= s.playoff_week_start
          ? "Playoffs"
          : "Regular season"
        : s.season_type === "post"
          ? "Postseason"
          : "Preseason";
    document.getElementById("league-meta").textContent = [
      `${s.season} · Week ${s.week} · ${phase}`,
      s.you ? `${s.you.team_name} (${s.you.record})` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    document.title = `${s.league} · Week ${s.week}`;
  } catch (error) {
    document.getElementById("league-name").textContent = "League unavailable";
    document.getElementById("league-meta").textContent = error.message;
  }
}

// ---------- Refresh loop ----------

let timer = null;
let lastRefresh = 0;
let nextRefresh = 0;
const refreshBtn = document.getElementById("refresh");
const statusEl = document.getElementById("refresh-status");

function updateStatus() {
  const live = isGameWindow();
  const mins = Math.max(0, Math.round((nextRefresh - Date.now()) / 60000));
  const updated = lastRefresh
    ? new Date(lastRefresh).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      })
    : "–";
  statusEl.classList.toggle("live", live);
  statusEl.textContent = live
    ? `Game time · updated ${updated}`
    : `Updated ${updated} · next in ${mins} min`;
}

async function refreshAll() {
  refreshBtn.disabled = true;
  try {
    await Promise.all([
      loadSummary(),
      ...Object.keys(renderers).map(loadPanel),
    ]);
  } finally {
    refreshBtn.disabled = false;
    lastRefresh = Date.now();
    schedule();
  }
}

function schedule() {
  clearTimeout(timer);
  const wait = refreshInterval();
  nextRefresh = Date.now() + wait;
  updateStatus();
  timer = setTimeout(() => {
    if (document.visibilityState === "visible") refreshAll();
    else schedule(); // don't poll a hidden tab; catch up when shown
  }, wait);
}

document.addEventListener("visibilitychange", () => {
  if (
    document.visibilityState === "visible" &&
    Date.now() - lastRefresh > refreshInterval()
  ) {
    refreshAll();
  }
});
setInterval(updateStatus, 30 * 1000);
refreshBtn.addEventListener("click", refreshAll);

// ---------- Theme toggle (auto / light / dark) ----------

const themeBtn = document.getElementById("theme");
const THEMES = ["auto", "light", "dark"];

function readTheme() {
  try {
    return localStorage.getItem("theme") || "auto";
  } catch {
    return "auto";
  }
}

function applyTheme(theme) {
  if (theme === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
  themeBtn.textContent = `Theme: ${theme}`;
}

themeBtn.addEventListener("click", () => {
  const next = THEMES[(THEMES.indexOf(readTheme()) + 1) % THEMES.length];
  try {
    localStorage.setItem("theme", next);
  } catch {
    // storage unavailable: theme just won't persist
  }
  applyTheme(next);
});

applyTheme(readTheme());
refreshAll();
