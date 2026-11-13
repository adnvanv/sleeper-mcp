/**
 * Small SVG charts for the Home tab. Thin marks, recessive grid, one axis,
 * hover tooltips, and a table view for every chart. Colors come from CSS
 * variables (validated against the dark surface): --chart-a, --chart-neg,
 * --chart-ref.
 */

import { h } from "./dom.js";

const NS = "http://www.w3.org/2000/svg";

function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, String(v));
  for (const c of children.flat(Infinity)) if (c != null) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

function niceMax(v) {
  if (v <= 0) return 10;
  const step = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / step) * step;
}

/** Tooltip shared by a chart: positioned inside the chart's wrapper. */
function tooltip(wrap) {
  const tip = h("div", { class: "chart-tip", role: "status" });
  tip.hidden = true;
  wrap.append(tip);
  return {
    show(x, y, lines) {
      tip.replaceChildren(...lines.map((l, i) => h(i === 0 ? "strong" : "div", {}, l)));
      tip.hidden = false;
      const w = wrap.clientWidth;
      const left = Math.min(Math.max(8, x + 12), w - tip.offsetWidth - 8);
      tip.style.left = `${left}px`;
      tip.style.top = `${Math.max(0, y - tip.offsetHeight - 10)}px`;
    },
    hide() {
      tip.hidden = true;
    },
  };
}

function tableView(caption, headers, rows) {
  return h(
    "details",
    { class: "chart-table" },
    h("summary", {}, "Show as table"),
    h(
      "table",
      {},
      h("caption", { class: "sr-only" }, caption),
      h("thead", {}, h("tr", {}, headers.map((c, i) => h("th", { class: i ? "num" : null }, c)))),
      h("tbody", {}, rows.map((r) => h("tr", {}, r.map((c, i) => h("td", { class: i ? "num" : null }, c))))),
    ),
  );
}

/** Weekly score: you (line + dots: filled = win, ring = loss) vs league median. */
export function weeklyChart(weeks) {
  const W = 640;
  const H = 230;
  const m = { t: 16, r: 92, b: 28, l: 40 };
  // Scores never sit near zero, so the axis starts just below the lowest one
  // (this is a line, not bars: no zero baseline needed).
  const values = weeks.flatMap((w) => [w.points, w.median]);
  const lo = Math.max(0, Math.floor((Math.min(...values) - 5) / 20) * 20);
  const hi = Math.ceil((Math.max(...values) + 5) / 20) * 20;
  const x = (i) => m.l + (weeks.length === 1 ? 0 : (i * (W - m.l - m.r)) / (weeks.length - 1));
  const y = (v) => m.t + (H - m.t - m.b) * (1 - (v - lo) / (hi - lo));
  const ticks = [];
  for (let t = lo; t <= hi; t += 20) ticks.push(t);
  const path = (key) => weeks.map((w, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(w[key]).toFixed(1)}`).join("");
  const last = weeks.length - 1;
  const youY = y(weeks[last].points);
  const medY = y(weeks[last].median);
  const apart = Math.abs(youY - medY) < 14;
  const svg = s(
    "svg",
    { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": "Your weekly score versus the league median" },
    ticks.map((t) => [
      s("line", { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), class: "grid" }),
      s("text", { x: m.l - 8, y: y(t) + 4, class: "axis", "text-anchor": "end" }, Math.round(t)),
    ]),
    weeks.map((w, i) => s("text", { x: x(i), y: H - 8, class: "axis", "text-anchor": "middle" }, w.week)),
    s("path", { d: path("median"), class: "line ref" }),
    s("path", { d: path("points"), class: "line a" }),
    weeks.map((w, i) =>
      s("circle", { cx: x(i), cy: y(w.points), r: 5, class: w.result === "W" ? "dot a" : "dot a hollow" }),
    ),
    s("text", { x: x(last) + 10, y: youY + (apart && youY < medY ? -4 : apart ? 8 : 4), class: "lbl" }, `You ${weeks[last].points.toFixed(1)}`),
    s("text", { x: x(last) + 10, y: medY + (apart && medY <= youY ? -4 : apart ? 8 : 4), class: "lbl muted" }, `Median ${weeks[last].median.toFixed(1)}`),
  );
  const cross = s("line", { y1: m.t, y2: H - m.b, class: "cross", visibility: "hidden" });
  svg.append(cross);
  const wrap = h("div", { class: "chart-wrap" }, svg);
  const tip = tooltip(wrap);
  svg.addEventListener("pointermove", (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    let i = Math.round(((px - m.l) / (W - m.l - m.r)) * (weeks.length - 1));
    i = Math.max(0, Math.min(weeks.length - 1, i));
    const w = weeks[i];
    cross.setAttribute("x1", x(i));
    cross.setAttribute("x2", x(i));
    cross.setAttribute("visibility", "visible");
    tip.show((x(i) / W) * r.width, (y(w.points) / H) * r.height, [
      `Week ${w.week}${w.result ? ` · ${w.result === "W" ? "Win" : w.result === "L" ? "Loss" : "Tie"}` : ""}`,
      `You ${w.points.toFixed(1)} (${ordinal(w.rank)} of ${w.teams})`,
      w.opponent ? `${w.opponent} ${w.opponent_points?.toFixed(1)}` : "",
      `League median ${w.median.toFixed(1)}`,
    ].filter(Boolean));
  });
  svg.addEventListener("pointerleave", () => {
    cross.setAttribute("visibility", "hidden");
    tip.hide();
  });
  return h(
    "div",
    {},
    h(
      "div",
      { class: "legend-row" },
      h("span", { class: "key" }, h("span", { class: "swatch line-a" }), "You (filled = win, ring = loss)"),
      h("span", { class: "key" }, h("span", { class: "swatch line-ref" }), "League median"),
    ),
    wrap,
    tableView(
      "Weekly scores",
      ["Week", "You", "Result", "Opponent", "Median", "Rank"],
      weeks.map((w) => [w.week, w.points.toFixed(1), w.result || "–", w.opponent_points?.toFixed(1) ?? "–", w.median.toFixed(1), `${w.rank}/${w.teams}`]),
    ),
  );
}

/** Points a week by starting position, you minus the league average (diverging bars). */
export function positionChart(positions) {
  const W = 640;
  const rowH = 30;
  const m = { t: 8, r: 64, b: 8, l: 64 };
  const H = m.t + m.b + rowH * positions.length;
  const lim = Math.max(2, ...positions.map((p) => Math.abs(p.diff))) * 1.1;
  const x0 = m.l + (W - m.l - m.r) / 2;
  const sx = (v) => (v / lim) * ((W - m.l - m.r) / 2);
  const svg = s(
    "svg",
    { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": "Points per week by position compared with the league average" },
    s("line", { x1: x0, x2: x0, y1: m.t - 4, y2: H - m.b + 4, class: "zero" }),
  );
  const wrap = h("div", { class: "chart-wrap" }, svg);
  const tip = tooltip(wrap);
  positions.forEach((p, i) => {
    const cy = m.t + rowH * i + rowH / 2;
    const w = Math.abs(sx(p.diff));
    const pos = p.diff >= 0;
    const bx = pos ? x0 : x0 - w;
    const bar = s("path", {
      d: roundedBar(bx, cy - 8, Math.max(w, 1), 16, pos),
      class: pos ? "bar a" : "bar neg",
    });
    const hit = s("rect", { x: m.l, y: cy - rowH / 2, width: W - m.l - m.r, height: rowH, class: "hit" });
    hit.addEventListener("pointerenter", () => {
      const r = svg.getBoundingClientRect();
      tip.show(((pos ? bx + w : bx) / W) * r.width, (cy / H) * r.height, [
        p.group,
        `You ${p.you.toFixed(1)} a week`,
        `League average ${p.league.toFixed(1)}`,
        `${p.diff >= 0 ? "+" : ""}${p.diff.toFixed(1)}`,
      ]);
    });
    hit.addEventListener("pointerleave", () => tip.hide());
    svg.append(
      s("text", { x: m.l - 12, y: cy + 4, class: "axis strong", "text-anchor": "end" }, p.group),
      bar,
      s("text", { x: pos ? bx + w + 6 : bx - 6, y: cy + 4, class: "lbl", "text-anchor": pos ? "start" : "end" }, `${p.diff >= 0 ? "+" : ""}${p.diff.toFixed(1)}`),
      hit,
    );
  });
  return h(
    "div",
    {},
    wrap,
    tableView(
      "Points per week by position",
      ["Position", "You", "League avg", "Difference"],
      positions.map((p) => [p.group, p.you.toFixed(1), p.league.toFixed(1), `${p.diff >= 0 ? "+" : ""}${p.diff.toFixed(1)}`]),
    ),
  );
}

/** Points left on the bench each week (best possible lineup minus started). */
export function benchChart(weeks) {
  const W = 640;
  const H = 190;
  const m = { t: 18, r: 12, b: 28, l: 40 };
  const max = niceMax(Math.max(5, ...weeks.map((w) => w.bench_left)) * 1.1);
  const band = (W - m.l - m.r) / weeks.length;
  const bw = Math.min(24, band * 0.6);
  const y = (v) => m.t + (H - m.t - m.b) * (1 - v / max);
  const worst = weeks.reduce((a, b) => (b.bench_left > a.bench_left ? b : a), weeks[0]);
  const svg = s(
    "svg",
    { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": "Points left on your bench each week" },
    [0, max / 2, max].map((t) => [
      s("line", { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), class: "grid" }),
      s("text", { x: m.l - 8, y: y(t) + 4, class: "axis", "text-anchor": "end" }, Math.round(t)),
    ]),
  );
  const wrap = h("div", { class: "chart-wrap" }, svg);
  const tip = tooltip(wrap);
  weeks.forEach((w, i) => {
    const cx = m.l + band * i + band / 2;
    const top = y(w.bench_left);
    const cost = w.result === "L" && w.opponent_points != null && w.best_lineup > w.opponent_points;
    svg.append(
      s("path", { d: roundedBar(cx - bw / 2, top, bw, Math.max(1, y(0) - top), true, true), class: `bar ${cost ? "neg" : "a"}` }),
      s("text", { x: cx, y: H - 8, class: "axis", "text-anchor": "middle" }, w.week),
    );
    if (w === worst && w.bench_left > 0) {
      svg.append(s("text", { x: cx, y: top - 6, class: "lbl", "text-anchor": "middle" }, w.bench_left.toFixed(1)));
    }
    const hit = s("rect", { x: cx - band / 2, y: m.t, width: band, height: H - m.t - m.b, class: "hit" });
    hit.addEventListener("pointerenter", () => {
      const r = svg.getBoundingClientRect();
      tip.show((cx / W) * r.width, (top / H) * r.height, [
        `Week ${w.week}${cost ? " · cost you the game" : ""}`,
        `Started ${w.points.toFixed(1)}`,
        `Best possible ${w.best_lineup.toFixed(1)}`,
        `Left on bench ${w.bench_left.toFixed(1)}`,
      ]);
    });
    hit.addEventListener("pointerleave", () => tip.hide());
    svg.append(hit);
  });
  return h(
    "div",
    {},
    h(
      "div",
      { class: "legend-row" },
      h("span", { class: "key" }, h("span", { class: "swatch bar-a" }), "Points left on bench"),
      h("span", { class: "key" }, h("span", { class: "swatch bar-neg" }), "Weeks the bench would have won"),
    ),
    wrap,
    tableView(
      "Points left on bench",
      ["Week", "Started", "Best possible", "Left", "Result"],
      weeks.map((w) => [w.week, w.points.toFixed(1), w.best_lineup.toFixed(1), w.bench_left.toFixed(1), w.result || "–"]),
    ),
  );
}

/** Bar path with 4px rounded data-end (top for columns, outer end for horizontal bars). */
function roundedBar(x, y, w, hgt, positive, vertical = false) {
  const r = Math.min(4, w / 2, hgt / 2);
  if (vertical) {
    return `M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z`;
  }
  if (positive) {
    return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt - r}Q${x + w},${y + hgt} ${x + w - r},${y + hgt}H${x}Z`;
  }
  return `M${x + w},${y}H${x + r}Q${x},${y} ${x},${y + r}V${y + hgt - r}Q${x},${y + hgt} ${x + r},${y + hgt}H${x + w}Z`;
}

function ordinal(n) {
  const v = n % 100;
  const sfx = ["th", "st", "nd", "rd"];
  return n + (sfx[(v - 20) % 10] || sfx[v] || sfx[0]);
}
