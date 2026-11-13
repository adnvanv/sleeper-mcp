/**
 * Renderers for the panels fed by the background poller: live scoring,
 * player news, usage risers, rest-of-season schedule, trade values and the
 * data-feed status. Each takes (data, { body, note, section }).
 */

import { h, fmt1, timeAgo } from "./dom.js";

/** replaceChildren, skipping null/false (which the DOM would print as text). */
const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));

/** Server-sent event topic → panel name. */
export const feedTopics = {
  activity: "activity",
  advice: "advice",
  live: "live",
  news: "news",
  usage: "usage",
  outlook: "outlook",
  values: "values",
  status: "feeds",
};

const pct = (x) => (x == null ? "–" : `${Math.round(x * 100)}%`);
const signed1 = (n) => (n > 0 ? `+${n.toFixed(1)}` : n.toFixed(1));
const time = (iso) =>
  new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function chipGroup(container, options, current, onPick) {
  container.replaceChildren(
    ...options.map(([key, label]) =>
      h(
        "button",
        {
          type: "button",
          class: "chip",
          "aria-pressed": String(current === key),
          onclick: () => onPick(key),
        },
        label,
      ),
    ),
  );
}

// ---------- Waiver advice ----------

function els(name) {
  const section = document.querySelector(`[data-panel="${name}"]`);
  return {
    section,
    body: section.querySelector("[data-body]"),
    note: section.querySelector("[data-note]"),
    filters: section.querySelector("[data-filters]"),
  };
}

const gain = (n) => `${n > 0 ? "+" : ""}${n.toFixed(1)}`;
const waiverDate = (iso) =>
  new Date(iso).toLocaleDateString([], { weekday: "short", hour: "numeric" });

function statusBadges(c) {
  const out = [];
  if (c.injury_status) {
    const s = c.injury_status.toLowerCase();
    out.push(
      h(
        "span",
        { class: `badge ${s === "questionable" ? "q" : "out"}`, title: c.injury_status },
        { questionable: "Q", doubtful: "D", out: "OUT", ir: "IR", suspended: "SUS", pup: "PUP" }[s] || c.injury_status,
      ),
    );
  }
  if (c.on_waivers_until) {
    out.push(
      h("span", { class: "badge waiver", title: "Recently dropped: claim it on waivers" }, `Waivers until ${waiverDate(c.on_waivers_until)}`),
    );
  }
  return out;
}

function compareTable(m) {
  const row = (label, a, b, better = "high") => {
    const na = typeof a === "number" ? a : null;
    const nb = typeof b === "number" ? b : null;
    const win = na != null && nb != null && na !== nb ? ((better === "high" ? na > nb : na < nb) ? "a" : "b") : null;
    return h(
      "tr",
      {},
      h("th", { scope: "row" }, label),
      h("td", { class: `num${win === "a" ? " pos" : ""}` }, a ?? "–"),
      h("td", { class: `num${win === "b" ? " neg" : ""}` }, b ?? "–"),
    );
  };
  const snap = (c) => (c.snap_share == null ? "–" : `${Math.round(c.snap_share * 100)}%`);
  return h(
    "table",
    { class: "compare" },
    h("thead", {}, h("tr", {}, h("th", {}, ""), h("th", { class: "num" }, "Add"), h("th", { class: "num" }, "Drop"))),
    h(
      "tbody",
      {},
      row("Expected pts/game", m.add.ros_ppg, m.drop.ros_ppg),
      row("Sleeper projection", m.add.projected_ppg, m.drop.projected_ppg),
      row("Games left", m.add.ros_games, m.drop.ros_games),
      row(`Week ${data_fromWeek} proj`, m.add.next_week, m.drop.next_week),
      row("Last 3 pts/game", m.add.last3_ppg, m.drop.last3_ppg),
      row("Season pts/game", m.add.season_ppg, m.drop.season_ppg),
      row("Snap share (last 2)", snap(m.add), snap(m.drop)),
      row("Playoff matchups (1 = easy)", m.add.playoff_rank, m.drop.playoff_rank, "low"),
    ),
  );
}

let data_fromWeek = 0;

function quotesBlock(c) {
  if (!c.quotes?.length && !c.notes?.length) return null;
  return h(
    "div",
    { class: "intel" },
    h("h5", {}, c.name),
    c.notes?.length ? h("ul", { class: "reasons" }, c.notes.map((n) => h("li", {}, n))) : null,
    c.quotes?.length
      ? h(
          "ul",
          { class: "quotes" },
          c.quotes.map((q) =>
            h("li", {}, h("q", {}, q.text), h("span", { class: "sub" }, ` ${q.source}, ${shortTime(q.date)}`)),
          ),
        )
      : null,
  );
}

function moveCard(m, i) {
  const who = (c) =>
    h(
      "span",
      { class: "mv-player" },
      h("span", { class: "mv-name" }, c.name),
      statusBadges(c),
      h("span", { class: "sub" }, ` ${c.position} · ${c.team || "FA"}`),
    );
  return h(
    "article",
    { class: `move${i === 0 ? " top" : ""}` },
    h(
      "header",
      { class: "mv-head" },
      h("div", { class: "mv-swap" }, h("span", { class: "mv-tag add" }, "ADD"), who(m.add)),
      h("div", { class: "mv-swap" }, h("span", { class: "mv-tag drop" }, "DROP"), who(m.drop)),
      h(
        "div",
        { class: "mv-gains" },
        h("span", { class: "gain-big pos", title: "Projected starting points gained, rest of season" }, gain(m.ros_gain)),
        h("span", { class: "sub" }, "ROS pts"),
        h(
          "span",
          { class: "sub" },
          `Playoffs ${gain(m.playoff_gain)} · Week ${data_fromWeek} ${gain(m.next_week_gain)}`,
        ),
      ),
    ),
    h(
      "div",
      { class: "mv-why" },
      h("div", {}, h("h4", {}, `Why add ${m.add.name.split(" ").slice(-1)[0]}`), h("ul", {}, m.add_reasons.map((r) => h("li", {}, r)))),
      h("div", {}, h("h4", {}, `Why drop ${m.drop.name.split(" ").slice(-1)[0]}`), h("ul", {}, m.drop_reasons.map((r) => h("li", {}, r)))),
    ),
    m.cautions?.length
      ? h(
          "div",
          { class: "caution", role: "note" },
          h("strong", {}, `Before you drop ${m.drop.name}:`),
          h("ul", {}, m.cautions.map((c) => h("li", {}, c))),
        )
      : null,
    h(
      "details",
      { class: "mv-more" },
      h("summary", {}, "What the news and numbers say"),
      h("div", { class: "intel-grid" }, quotesBlock(m.add), quotesBlock(m.drop)),
      compareTable(m),
    ),
  );
}

function renderAdvice(data, { body, note }) {
  data_fromWeek = data.from_week;
  note.textContent = `Weeks ${data.from_week}–${data.through_week} · playoffs from week ${data.playoff_start}`;
  fill(
    body,
    data.moves.length
      ? data.moves.map(moveCard)
      : h("p", { class: "state" }, "No free agent beats anyone on your roster right now. Check back after news or projections change."),
    h(
      "p",
      { class: "legend" },
      `How this works: each player's expected points a game blends Sleeper's projection with how he's actually been used in the games he played (targets, carries, snaps), leaning on recent usage more when there are more games to go on and when other Sleeper managers are adding him. For every remaining week through your playoffs it then builds your best lineup, scored your league's way. "ROS pts" is how many more starting points that lineup scores after the swap, so byes, injuries and position needs are already counted. News is read for returns from injury, practice reports and role descriptions, and quoted where it matters. `,
      data.waiver_type === "rolling"
        ? `Your league uses rolling waivers: players dropped in the last ${data.waiver_clear_days} days need a waiver claim, everyone else can be added right away.`
        : "",
      data.has_usage ? "" : " Usage trends are still loading.",
    ),
  );
  renderDrops(data);
  renderAvailable(data);
}

const VERDICT = { drop: "Drop", expendable: "Expendable", keep: "Keep" };

function renderDrops(data) {
  const { body, note } = els("drops");
  note.textContent = "Least useful first";
  fill(
    body,
    h(
      "ul",
      { class: "list drops" },
      data.drops.map((d) =>
        h(
          "li",
          {},
          h(
            "div",
            { class: "drop-head" },
            h("span", { class: `verdict-pill ${d.verdict}` }, VERDICT[d.verdict]),
            h("span", { class: "mv-name" }, d.player.name),
            statusBadges(d.player),
            h("span", { class: "sub" }, ` ${d.player.position} · ${d.player.team || "FA"}`),
            h("span", { class: "drop-pts", title: "Starting points he adds to your lineup, rest of season" }, `${d.ros_contribution.toFixed(1)} pts`),
          ),
          h(
            "ul",
            { class: "reasons" },
            d.reasons
              .filter((r) => !r.startsWith("Hold? "))
              .slice(0, 3)
              .map((r) => h("li", {}, r)),
          ),
          d.player.hold_flags?.length
            ? h(
                "div",
                { class: "caution small" },
                h("strong", {}, "Think twice:"),
                h("ul", {}, d.player.hold_flags.map((r) => h("li", {}, r))),
              )
            : null,
          d.player.quotes?.length || d.player.notes?.length
            ? h("details", { class: "mv-more" }, h("summary", {}, "What the news and numbers say"), quotesBlock(d.player))
            : null,
        ),
      ),
    ),
    h(
      "p",
      { class: "legend" },
      "Points = how many starting points your best lineups lose without him the rest of the season. Bench depth also protects you against injuries, which projections can't see coming.",
    ),
  );
}

let availablePos = null;

function renderAvailable(data) {
  const { body, filters } = els("available");
  const order = ["QB", "RB", "WR", "TE", "K", "DEF"];
  const positions = Object.keys(data.available).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  if (!positions.includes(availablePos)) availablePos = positions.includes("RB") ? "RB" : positions[0];
  const draw = () => {
    chipGroup(filters, positions.map((p) => [p, p]), availablePos, (key) => {
      availablePos = key;
      draw();
    });
    const rows = data.available[availablePos] || [];
    fill(
      body,
      rows.length
        ? h(
            "table",
            {},
            h(
              "thead",
              {},
              h(
                "tr",
                {},
                h("th", {}, "Player"),
                h("th", { class: "num", title: "Projected points a game, rest of season" }, "ROS"),
                h("th", { class: "num", title: `Projection for week ${data.from_week}` }, `W${data.from_week}`),
                h("th", { class: "num hide-sm", title: "Points a game, last 3 games" }, "L3"),
                h("th", { class: "num hide-sm", title: "Snap share, last 2 games" }, "Snap"),
              ),
            ),
            h(
              "tbody",
              {},
              rows.map((c) =>
                h(
                  "tr",
                  {},
                  h(
                    "td",
                    {},
                    h(
                      "div",
                      { class: "player" },
                      h("span", {}, c.name, statusBadges(c)),
                      h(
                        "span",
                        { class: "sub" },
                        [c.team, c.trending_adds >= 1000 ? `${Math.round(c.trending_adds / 100) / 10}K adds` : null, c.news ? c.news.title : null]
                          .filter(Boolean)
                          .join(" · "),
                      ),
                    ),
                  ),
                  h("td", { class: "num strong" }, fmt1(c.ros_ppg)),
                  h("td", { class: "num" }, fmt1(c.next_week)),
                  h("td", { class: "num hide-sm" }, fmt1(c.last3_ppg)),
                  h("td", { class: "num hide-sm" }, c.snap_share == null ? "–" : pct(c.snap_share)),
                ),
              ),
            ),
          )
        : h("p", { class: "state" }, "Nobody available."),
    );
  };
  draw();
}

// ---------- Activity stream ----------

function shortTime(iso) {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString([], { weekday: "short" });
}

function renderActivity(data, { body, note, section }) {
  section.classList.toggle("is-live", data.live);
  note.textContent = data.live ? "Live · your players are on the field" : "Plays and news for your players";
  if (!data.items.length) {
    fill(body, h("p", { class: "state" }, "Nothing yet this week. Plays show up here as soon as your players' games start."));
    return;
  }
  fill(
    body,
    h(
      "ul",
      { class: "act-list" },
      data.items.slice(0, 40).map((a, i) =>
        h(
          "li",
          { class: [a.kind, i === 0 ? "latest" : "", a.scoring ? "scoring" : ""].join(" ").trim() },
          h("span", { class: "act-when", title: new Date(a.at).toLocaleString() }, shortTime(a.at)),
          h(
            "span",
            { class: "act-head" },
            a.name,
            a.starter ? null : h("span", { class: "bench-tag" }, "BN"),
            " ",
            h("span", { class: "what" }, a.kind === "news" ? "News" : a.headline),
          ),
          h("span", { class: "act-when act-clock" }, a.clock || a.team || ""),
          h(
            "span",
            { class: "act-detail", title: a.kind === "news" ? a.headline : a.detail },
            a.kind === "news"
              ? a.url
                ? h("a", { href: a.url, target: "_blank", rel: "noopener noreferrer" }, a.headline)
                : a.headline
              : a.detail,
          ),
        ),
      ),
    ),
  );
}

// ---------- Live ----------

let lastPoints = new Map();

/** Latest pace per player from the live feed, for other panels (roster). */
export const livePace = new Map();

const PACE_TITLE = {
  good: "Ahead of his projection for the time played",
  bad: "Well behind his projection for the time played",
  even: "Close to his projection",
};

export function paceMark(pace) {
  if (pace !== "good" && pace !== "bad") return null;
  return h("span", { class: `pace-arrow ${pace}`, "aria-hidden": "true" }, pace === "good" ? "▲" : "▼");
}

function liveRow(p, flash) {
  const g = p.game;
  const state =
    g.state === "in"
      ? h("span", { class: "badge live-badge" }, "LIVE")
      : g.state === "post"
        ? h("span", { class: "badge done" }, "FINAL")
        : null;
  return h(
    "tr",
    { class: [flash ? "bump" : "", g.state === "in" ? "playing" : "", p.pace ? `pace-${p.pace}` : ""].join(" ").trim() || null },
    h("td", { class: "slot" }, p.slot),
    h(
      "td",
      {},
      h(
        "div",
        { class: "player" },
        h(
          "span",
          {},
          p.name,
          state,
          g.has_ball ? h("span", { class: "badge ball", title: "Their team has the ball" }, "BALL") : null,
          g.red_zone ? h("span", { class: "badge rz", title: "In the red zone" }, "RZ") : null,
        ),
        h(
          "span",
          { class: "sub" },
          [p.position, p.team || "FA", g.opponent, g.state === "bye" ? "Bye" : g.detail]
            .filter(Boolean)
            .join(" · "),
        ),
        p.stat_line ? h("span", { class: "sub statline" }, p.stat_line) : null,
      ),
    ),
    h(
      "td",
      { class: `num strong pts-${p.pace || "none"}`, title: p.pace ? `${PACE_TITLE[p.pace]} (projected ${p.projected})` : null },
      paceMark(p.pace),
      p.points.toFixed(1),
    ),
    h(
      "td",
      { class: "num muted", title: p.projected == null ? "No projection" : `Projected ${p.projected}` },
      p.game.state === "post" ? "–" : fmt1(p.projected_final),
    ),
  );
}

function liveTable(side, label) {
  const rows = side.starters.map((p) => {
    const key = `${side.roster_id}:${p.player_id}`;
    const flash = lastPoints.has(key) && lastPoints.get(key) !== p.points;
    return liveRow(p, flash);
  });
  return h(
    "div",
    { class: "live-side" },
    h(
      "h3",
      {},
      label,
      h(
        "span",
        { class: "muted" },
        ` ${side.playing_now} playing · ${side.yet_to_play} to play`,
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
          h("th", { class: "num", title: "Projected final: points so far plus the projection for game time left" }, "Proj"),
        ),
      ),
      h("tbody", {}, rows),
    ),
  );
}

function gameCard(g) {
  const team = (side, other) =>
    h(
      "div",
      { class: `gteam${g.state !== "pre" && side.score > other.score ? " leading" : ""}` },
      h("span", {}, side.team, g.possession === side.team ? h("span", { class: "poss", title: "Has the ball" }, " ●") : null),
      h("span", { class: "pts" }, g.state === "pre" ? "" : side.score),
    );
  return h(
    "div",
    { class: `game ${g.state}${g.red_zone ? " redzone" : ""}` },
    team(g.away, g.home),
    team(g.home, g.away),
    h("div", { class: "gdetail" }, g.state === "pre" ? new Date(g.start).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) : g.detail),
    g.down_distance ? h("div", { class: "gdetail" }, g.down_distance, g.red_zone ? " · Red zone" : "") : null,
    g.last_play ? h("div", { class: "lastplay", title: g.last_play }, g.last_play) : null,
  );
}

function renderLive(data, { body, note, section }) {
  section.classList.toggle("is-live", data.mode === "fast");
  note.textContent =
    data.mode === "fast"
      ? `Your players are on the field · updating every ${data.live_poll_seconds}s`
      : data.mode === "game_day"
        ? `Week ${data.week} · games on, none of yours right now`
        : `Week ${data.week}`;
  if (!data.me) {
    fill(body, h("p", { class: "state" }, "No matchup this week."));
    return;
  }
  const me = data.me;
  const opp = data.opponent;
  const win = data.win_probability;
  const score = h(
    "div",
    { class: "scoreline" },
    h(
      "div",
      { class: "sl-team mine" },
      h("span", { class: "sl-name", title: me.team_name }, me.team_name),
      h("span", { class: `sl-pts pts-${me.pace || "none"}`, title: me.pace ? PACE_TITLE[me.pace] : null }, paceMark(me.pace), me.points.toFixed(2)),
      h("span", { class: "sub" }, `proj ${me.projected_final.toFixed(1)}`),
    ),
    h(
      "div",
      { class: "sl-mid" },
      win == null
        ? null
        : [
            h("span", { class: `sl-win ${win >= 0.5 ? "pos" : "neg"}` }, `${Math.round(win * 100)}%`),
            h("span", { class: "sub" }, "win chance"),
            h(
              "span",
              { class: "bar-track wide", "aria-hidden": "true" },
              h("span", { class: "bar-fill", style: { width: `${(win * 100).toFixed(1)}%` } }),
            ),
          ],
    ),
    opp
      ? h(
          "div",
          { class: "sl-team" },
          h("span", { class: "sl-name", title: opp.team_name }, opp.team_name),
          h("span", { class: `sl-pts pts-${opp.pace || "none"}`, title: opp.pace ? PACE_TITLE[opp.pace] : null }, paceMark(opp.pace), opp.points.toFixed(2)),
          h("span", { class: "sub" }, `proj ${opp.projected_final.toFixed(1)}`),
        )
      : h("div", { class: "sl-team" }, h("span", { class: "sub" }, "Bye week")),
  );

  const ticker = data.events.length
    ? h(
        "ul",
        { class: "ticker", "aria-label": "Recent scoring" },
        data.events.slice(0, 8).map((e) =>
          h(
            "li",
            { class: e.side === "mine" ? "pos" : "neg" },
            h("span", { class: "tk-delta" }, signed1(e.delta)),
            h("span", {}, e.name, e.side === "mine" ? "" : " (opp)"),
            h("span", { class: "muted" }, ` ${e.total.toFixed(1)} · ${time(e.at)}`),
          ),
        ),
      )
    : null;

  const started = data.games.filter((g) => g.state !== "pre");
  const upcoming = data.games.filter((g) => g.state === "pre");
  const games = [
    started.length ? h("div", { class: "games" }, started.map(gameCard)) : null,
    upcoming.length
      ? h(
          "details",
          { class: "upcoming" },
          h("summary", {}, `Upcoming games with your matchup's players (${upcoming.length})`),
          h("div", { class: "games" }, upcoming.map(gameCard)),
        )
      : null,
  ];

  fill(body, 
    score,
    ticker,
    games,
    h(
      "div",
      { class: "live-sides" },
      liveTable(me, "You"),
      opp ? liveTable(opp, opp.team_name) : null,
    ),
    data.has_projections
      ? h(
          "p",
          { class: "legend" },
          "Proj = points so far plus Sleeper's projection for the game time left, in your scoring. ",
          "Win chance is a rough estimate from those projections.",
        )
      : null,
  );

  livePace.clear();
  for (const s of [me, opp].filter(Boolean)) for (const p of s.starters) livePace.set(p.player_id, p.pace);
  document.dispatchEvent(new CustomEvent("livepace"));

  lastPoints = new Map(
    [me, opp].filter(Boolean).flatMap((s) => s.starters.map((p) => [`${s.roster_id}:${p.player_id}`, p.points])),
  );
}

// ---------- News ----------

let newsFilter = "mine";
let newsKind = "all";
const KIND_LABEL = {
  returning: "Returning",
  injury: "Injury",
  role: "Role",
  transaction: "Move",
  general: "News",
};

function renderNews(data, { body, section }) {
  const filters = section.querySelector("[data-filters]");
  const draw = () => {
    chipGroup(
      filters,
      [
        ["mine", `Mine ${data.counts.mine}`],
        ["league", `League ${data.counts.league}`],
        ["free_agent", `Free agents ${data.counts.free_agent}`],
        ["all", "All"],
      ],
      newsFilter,
      (key) => {
        newsFilter = key;
        draw();
      },
    );
    const kinds = h("div", { class: "chips sub-chips", role: "group", "aria-label": "News type" });
    chipGroup(
      kinds,
      [["all", "Any type"], ["returning", "Returning"], ["injury", "Injury"], ["role", "Role"], ["transaction", "Moves"]],
      newsKind,
      (key) => {
        newsKind = key;
        draw();
      },
    );
    const items = data.items.filter(
      (n) =>
        (newsFilter === "all" || n.relevance === newsFilter) &&
        (newsKind === "all" || n.kind === newsKind),
    );
    fill(body, 
      kinds,
      items.length
        ? h(
            "ul",
            { class: "list news" },
            items.slice(0, 40).map((n) =>
              h(
                "li",
                {},
                h(
                  "div",
                  { class: "news-head" },
                  h("span", { class: `type kind-${n.kind}` }, KIND_LABEL[n.kind] || n.kind),
                  h(
                    "a",
                    { href: n.url, target: "_blank", rel: "noopener noreferrer" },
                    n.title,
                  ),
                ),
                n.summary ? h("p", { class: "news-sum" }, n.summary) : null,
                h(
                  "span",
                  { class: "sub" },
                  [
                    n.source,
                    timeAgo(n.published),
                    ...n.players.map((p) =>
                      `${p.name}${p.position ? ` (${p.position}${p.team ? `, ${p.team}` : ""})` : ""}${
                        n.relevance === "mine" ? "" : p.owner ? ` · ${p.owner}` : " · free agent"
                      }`,
                    ),
                  ].join(" · "),
                ),
              ),
            ),
          )
        : h(
            "p",
            { class: "state" },
            newsFilter === "mine" ? "No recent news about your players." : "Nothing matches.",
          ),
    );
  };
  draw();
}

// ---------- Usage risers ----------

let usageTab = "free_agents";

function renderUsage(data, { body, note, section }) {
  const filters = section.querySelector("[data-filters]");
  const w = data.weeks;
  note.textContent = w.length ? `Last 2 games vs weeks ${w[0]}–${w.at(-3) ?? w[0]}` : "";
  const draw = () => {
    chipGroup(
      filters,
      [
        ["free_agents", "Free agents"],
        ["mine", "My players"],
        ["league", "Other teams"],
      ],
      usageTab,
      (key) => {
        usageTab = key;
        draw();
      },
    );
    const rows = data[usageTab] || [];
    fill(body, 
      rows.length
        ? h(
            "table",
            {},
            h(
              "thead",
              {},
              h(
                "tr",
                {},
                h("th", {}, "Player"),
                h("th", { class: "num", title: "Share of offensive snaps, last 2 games (change)" }, "Snaps"),
                h("th", { class: "num", title: "Targets + carries a game, last 2 games (change)" }, "Opp/g"),
                h("th", { class: "num hide-sm", title: "Points a game, last 2 games" }, "Pts/g"),
              ),
            ),
            h(
              "tbody",
              {},
              rows.map((t) =>
                h(
                  "tr",
                  {},
                  h(
                    "td",
                    {},
                    h(
                      "div",
                      { class: "player" },
                      h("span", {}, t.name),
                      h(
                        "span",
                        { class: "sub" },
                        [t.position, t.team || "FA", usageTab === "league" ? t.owner : null]
                          .filter(Boolean)
                          .join(" · "),
                      ),
                      t.reason ? h("span", { class: "sub" }, t.reason) : null,
                    ),
                  ),
                  h(
                    "td",
                    { class: "num" },
                    pct(t.recent.snap_share),
                    t.change.snap_share != null
                      ? h(
                          "span",
                          { class: `delta ${t.change.snap_share > 0 ? "pos" : t.change.snap_share < 0 ? "neg" : "muted"}` },
                          ` ${t.change.snap_share > 0 ? "+" : ""}${Math.round(t.change.snap_share * 100)}`,
                        )
                      : null,
                  ),
                  h(
                    "td",
                    { class: "num" },
                    fmt1(t.recent.opportunities),
                    h(
                      "span",
                      { class: `delta ${t.change.opportunities > 0 ? "pos" : t.change.opportunities < 0 ? "neg" : "muted"}` },
                      ` ${signed1(t.change.opportunities)}`,
                    ),
                  ),
                  h("td", { class: "num hide-sm" }, fmt1(t.recent.points)),
                ),
              ),
            ),
          )
        : h("p", { class: "state" }, "No clear risers right now."),
      h(
        "p",
        { class: "legend" },
        "A growing role (more snaps, targets and carries) predicts breakouts better than one big box score.",
      ),
    );
  };
  draw();
}

// ---------- Rest-of-season schedule ----------

function renderOutlook(data, { body, note }) {
  const weeks = [];
  for (let w = data.from_week; w <= data.through_week; w++) weeks.push(w);
  note.textContent = [
    data.trade_deadline ? `Trade deadline: week ${data.trade_deadline}` : null,
    `Playoffs from week ${data.playoff_start}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const cell = (wk) => {
    if (!wk.opponent) return h("td", { class: "sos bye" }, "BYE");
    const cls = wk.rank == null ? "" : wk.rank <= 8 ? "easy" : wk.rank >= 25 ? "hard" : "";
    return h(
      "td",
      {
        class: `sos ${cls}`.trim(),
        title:
          wk.rank == null
            ? wk.opponent
            : `${wk.home ? "vs" : "@"} ${wk.opponent}: allows ${wk.allowed} pts a game to this position (rank ${wk.rank} of 32, 1 = easiest)`,
      },
      `${wk.home ? "" : "@"}${wk.opponent}`,
      wk.rank != null ? h("span", { class: "rk" }, wk.rank) : null,
    );
  };
  fill(body, 
    data.players.length
      ? h(
          "div",
          { class: "scroll-x" },
          h(
            "table",
            { class: "sos-table" },
            h(
              "thead",
              {},
              h(
                "tr",
                {},
                h("th", {}, "Player"),
                h("th", { class: "num", title: "Average opponent rank, rest of season (1 = easiest)" }, "ROS"),
                h("th", { class: "num", title: "Average opponent rank in your fantasy playoffs" }, "PO"),
                weeks.map((w) =>
                  h("th", { class: `num${w >= data.playoff_start ? " po" : ""}` }, `W${w}`),
                ),
              ),
            ),
            h(
              "tbody",
              {},
              data.players.map((p) =>
                h(
                  "tr",
                  {},
                  h(
                    "td",
                    {},
                    h(
                      "div",
                      { class: "player" },
                      h("span", {}, p.name),
                      h("span", { class: "sub" }, `${p.position} · ${p.team || "FA"}`),
                    ),
                  ),
                  h("td", { class: `num ${p.grade === "easy" ? "pos" : p.grade === "hard" ? "neg" : ""}`.trim() }, fmt1(p.ros_rank)),
                  h("td", { class: "num" }, fmt1(p.playoff_rank)),
                  p.weeks.map(cell),
                ),
              ),
            ),
          ),
        )
      : h("p", { class: "state" }, "No schedule data yet."),
    h(
      "p",
      { class: "legend" },
      `Numbers are how each opponent ranks in fantasy points allowed to that position this season (1 = allows the most, so the easiest; 32 = toughest), from ${data.weeks_of_data} weeks of games in your scoring.`,
    ),
  );
}

// ---------- Trade values + calculator ----------

let partnerId = null;
const giving = new Set();
const getting = new Set();

function renderValues(data, { body, note, section }) {
  const filters = section.querySelector("[data-filters]");
  const mine = data.teams.find((t) => t.is_you);
  const others = data.teams.filter((t) => !t.is_you);
  if (!mine) {
    fill(body, h("p", { class: "state" }, "You are not in this league."));
    return;
  }
  if (!partnerId || !others.some((t) => t.roster_id === partnerId)) {
    partnerId = others[0]?.roster_id ?? null;
  }
  const rank = data.teams.findIndex((t) => t.is_you) + 1;
  note.textContent = `${data.source} · your roster ranks ${rank} of ${data.teams.length}`;

  const draw = () => {
    const partner = others.find((t) => t.roster_id === partnerId);
    const select = h(
      "select",
      {
        "aria-label": "Trade partner",
        onchange: (e) => {
          partnerId = Number(e.target.value);
          getting.clear();
          draw();
        },
      },
      others.map((t) =>
        h("option", { value: t.roster_id, selected: t.roster_id === partnerId }, t.team_name),
      ),
    );
    filters.replaceChildren(select);

    const pick = (team, set) =>
      h(
        "ul",
        { class: "list picks" },
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
                    draw();
                  },
                }),
                h(
                  "span",
                  { class: "player" },
                  h("span", {}, p.name),
                  h("span", { class: "sub" }, `${p.position || ""}${p.position_rank ? p.position_rank : ""} · ${p.team || "FA"}`),
                ),
              ),
              h(
                "span",
                { class: "adds" },
                p.value.toLocaleString(),
                p.trend_30d
                  ? h("span", { class: `delta ${p.trend_30d > 0 ? "pos" : "neg"}`, title: "30-day trend" }, ` ${p.trend_30d > 0 ? "▲" : "▼"}`)
                  : null,
              ),
            ),
          ),
      );
    const total = (team, set) =>
      team.players.filter((p) => set.has(p.player_id)).reduce((s, p) => s + p.value, 0);
    const give = total(mine, giving);
    const get = partner ? total(partner, getting) : 0;
    const diff = get - give;
    const base = Math.max(give, get, 1);
    const verdict =
      !give && !get
        ? "Tick players on both sides to compare a trade."
        : Math.abs(diff) / base < 0.05
          ? "Even trade"
          : diff > 0
            ? `You win by ${diff.toLocaleString()} (${Math.round((diff / base) * 100)}%)`
            : `You lose by ${(-diff).toLocaleString()} (${Math.round((-diff / base) * 100)}%)`;

    fill(body, 
      h(
        "div",
        { class: `verdict ${!give && !get ? "" : Math.abs(diff) / base < 0.05 ? "" : diff > 0 ? "pos" : "neg"}`.trim(), role: "status" },
        h("strong", {}, verdict),
        give || get ? h("span", { class: "sub" }, ` You give ${give.toLocaleString()} · you get ${get.toLocaleString()}`) : null,
      ),
      h(
        "div",
        { class: "trade-cols" },
        h("div", {}, h("h3", {}, "You give"), pick(mine, giving)),
        partner ? h("div", {}, h("h3", {}, `${partner.team_name} gives`), pick(partner, getting)) : null,
      ),
      h(
        "details",
        { class: "league-values" },
        h("summary", {}, "Roster values by team"),
        h(
          "ul",
          { class: "list" },
          data.teams.map((t) =>
            h(
              "li",
              { class: t.is_you ? "mine" : null },
              h("span", {}, t.team_name),
              h("span", { class: "adds" }, t.total.toLocaleString()),
            ),
          ),
        ),
      ),
      h(
        "p",
        { class: "legend" },
        "Crowd-sourced redraft values from FantasyCalc, matched to your league's format. ",
        "Adding values up flatters 2-for-1 offers: the side getting the single best player usually wins those.",
      ),
    );
  };
  draw();
}

// ---------- Feed status ----------

function renderFeeds(data, { body, note }) {
  const label = { fast: "live (your players are on)", game_day: "game day", idle: "idle" }[data.mode] || data.mode;
  note.textContent = `· ${label}`;
  fill(body, 
    h(
      "ul",
      { class: "list feed-status" },
      data.feeds.map((f) =>
        h(
          "li",
          {},
          h("span", {}, f.name),
          h(
            "span",
            { class: f.error ? "neg" : "muted" },
            f.error
              ? `error: ${f.error}`
              : `every ${f.every_seconds < 60 ? `${f.every_seconds}s` : `${Math.round(f.every_seconds / 60)} min`} · ${f.last_ok ? timeAgo(f.last_ok) : "pending"}`,
          ),
        ),
      ),
    ),
  );
}

export const feedRenderers = {
  activity: renderActivity,
  advice: renderAdvice,
  live: renderLive,
  news: renderNews,
  usage: renderUsage,
  outlook: renderOutlook,
  values: renderValues,
  feeds: renderFeeds,
};
