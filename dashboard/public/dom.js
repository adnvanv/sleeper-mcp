/** Shared DOM and formatting helpers for the dashboard modules. */

// ---------- DOM helpers (never innerHTML: team names are user input) ----------

export function h(tag, attrs = {}, ...children) {
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

export const fmt1 = (n) => (n == null ? "–" : Number(n).toFixed(1));
export const fmtSigned = (n) => (n > 0 ? `+${n.toFixed(2)}` : n.toFixed(2));
export const fmtCount = (n) =>
  n >= 1e6
    ? `${(n / 1e6).toFixed(1)}M`
    : n >= 1e3
      ? `${Math.round(n / 1e3)}K`
      : String(n);
export const record = (r) => `${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ""}`;

export function timeAgo(iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

export function injuryBadge(status, onBye) {
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

