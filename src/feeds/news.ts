/**
 * Player news from public feeds (Rotowire RSS, ESPN's news API), matched to
 * Sleeper player IDs and tagged by what kind of news it is and whether the
 * player is yours, on another league roster, or a free agent.
 */

import { parseRss, parseRssDate } from "./rss.js";
import type { SleeperPlayer } from "../types.js";

export type NewsKind =
  | "returning"
  | "injury"
  | "role"
  | "transaction"
  | "general";

export type Relevance = "mine" | "league" | "free_agent" | "none";

export interface NewsItem {
  id: string;
  source: string;
  title: string;
  summary: string;
  url: string;
  published: string;
  player_ids: string[];
  kind: NewsKind;
}

export interface TaggedNewsItem extends NewsItem {
  relevance: Relevance;
  players: {
    player_id: string;
    name: string;
    position: string | null;
    team: string | null;
    owner: string | null;
  }[];
}

export interface PlayerIndex {
  byRotowire: Map<string, string>;
  byEspn: Map<string, string>;
  byName: Map<string, string[]>;
}

export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[.'’`-]/g, "")
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "")
    .replace(/[^a-z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildPlayerIndex(
  players: Map<string, SleeperPlayer>,
): PlayerIndex {
  const index: PlayerIndex = {
    byRotowire: new Map(),
    byEspn: new Map(),
    byName: new Map(),
  };
  for (const [id, p] of players) {
    const any = p as SleeperPlayer & {
      rotowire_id?: number | string | null;
      espn_id?: number | string | null;
    };
    if (any.rotowire_id != null) index.byRotowire.set(String(any.rotowire_id), id);
    if (any.espn_id != null) index.byEspn.set(String(any.espn_id), id);
    const full = `${p.first_name || ""} ${p.last_name || ""}`;
    const key = normalizeName(full);
    if (key && p.team) {
      index.byName.set(key, [...(index.byName.get(key) || []), id]);
    }
  }
  return index;
}

/** Name lookup that only answers when exactly one player on a team matches. */
function byName(index: PlayerIndex, name: string): string | undefined {
  const ids = index.byName.get(normalizeName(name));
  return ids && ids.length === 1 ? ids[0] : undefined;
}

// Order matters: "full practice" is a return signal before it's an injury one.
const KIND_PATTERNS: [NewsKind, RegExp][] = [
  [
    "returning",
    /\b(activated|designated (?:to|for) return|cleared|returns?|returning|back at practice|full practice|practiced in full|set to play|expected to play|will play|off (?:injured reserve|ir)|good to go|no injury designation|welcome back|back from)\b/i,
  ],
  [
    "injury",
    /\b(injured reserve|on ir|ruled out|out for|won't play|will not play|doubtful|questionable|limited|did not practice|dnp|sidelined|surgery|week-to-week|concussion|injur(?:y|ies|ed)|sprain|strain|tear|torn)\b/i,
  ],
  [
    "transaction",
    /\b(signs?|signed|re-signed|released|waived|traded|trades? for|claimed|cut|elevated|practice squad)\b/i,
  ],
  [
    "role",
    /\b(starts?|starting|starter|promoted|depth chart|lead back|workload|snaps?|targets?|role|first start|takes over|bell ?cow|carries|usage)\b/i,
  ],
];

export function classifyNews(title: string, summary = ""): NewsKind {
  const headline = title.includes(":") ? title.split(":").slice(1).join(":") : title;
  for (const [kind, pattern] of KIND_PATTERNS) {
    if (pattern.test(headline)) return kind;
  }
  for (const [kind, pattern] of KIND_PATTERNS) {
    if (pattern.test(summary)) return kind;
  }
  return "general";
}

/** Rotowire RSS: titles look like "Puka Nacua: Lands on injured reserve". */
export function parseRotowireNews(xml: string, index: PlayerIndex): NewsItem[] {
  return parseRss(xml).map((item) => {
    const rwId = item.link.match(/-(\d+)\/?$/)?.[1];
    const name = item.title.split(":")[0].trim();
    const playerId =
      (rwId && index.byRotowire.get(rwId)) || byName(index, name);
    const summary = item.description
      .replace(/Visit RotoWire\.com for more analysis on this update\.?/i, "")
      .trim();
    return {
      id: `rotowire:${item.guid}`,
      source: "Rotowire",
      title: item.title,
      summary,
      url: item.link.replace(/([^:])\/\//g, "$1/"),
      published: parseRssDate(item.pubDate) || new Date().toISOString(),
      player_ids: playerId ? [playerId] : [],
      kind: classifyNews(item.title, summary),
    };
  });
}

interface EspnArticle {
  id: number | string;
  type?: string;
  headline?: string;
  description?: string;
  published?: string;
  links?: { web?: { href?: string } };
  categories?: { type?: string; athleteId?: number; description?: string }[];
}

/** ESPN's public news API. Video-only items ("Media") are skipped. */
export function parseEspnNews(
  json: { articles?: EspnArticle[] },
  index: PlayerIndex,
): NewsItem[] {
  return (json.articles || [])
    .filter((a) => a.headline && a.type !== "Media")
    .map((a) => {
      const athletes = (a.categories || []).filter((c) => c.type === "athlete");
      const ids = athletes
        .map(
          (c) =>
            (c.athleteId != null && index.byEspn.get(String(c.athleteId))) ||
            (c.description ? byName(index, c.description) : undefined),
        )
        .filter((id): id is string => !!id);
      return {
        id: `espn:${a.id}`,
        source: "ESPN",
        title: a.headline!,
        summary: (a.description || "").trim(),
        url: a.links?.web?.href || "https://www.espn.com/nfl/",
        published: a.published || new Date().toISOString(),
        // Recaps tag whole rosters; more than a few names isn't player news.
        player_ids: [...new Set(ids)].slice(0, 4),
        kind: classifyNews(a.headline!, a.description),
      };
    });
}

/** Merge new items into the stored list: dedupe by id, newest first, capped. */
export function mergeNews(
  existing: NewsItem[],
  incoming: NewsItem[],
  max = 400,
): NewsItem[] {
  const byId = new Map(existing.map((n) => [n.id, n]));
  for (const item of incoming) byId.set(item.id, { ...byId.get(item.id), ...item });
  return [...byId.values()]
    .sort((a, b) => b.published.localeCompare(a.published))
    .slice(0, max);
}

export interface NewsContext {
  mine: Set<string>;
  /** player_id → owning team name, for every rostered player in the league. */
  owners: Map<string, string>;
  players: Map<string, SleeperPlayer>;
}

const RANK: Record<Relevance, number> = {
  mine: 0,
  league: 1,
  free_agent: 2,
  none: 3,
};

export function tagNews(items: NewsItem[], ctx: NewsContext): TaggedNewsItem[] {
  return items.map((item) => {
    const players = item.player_ids.map((id) => {
      const p = ctx.players.get(id);
      return {
        player_id: id,
        name: p ? `${p.first_name} ${p.last_name}`.trim() : id,
        position: p?.position || null,
        team: p?.team || null,
        owner: ctx.owners.get(id) || null,
      };
    });
    let relevance: Relevance = "none";
    for (const id of item.player_ids) {
      const r: Relevance = ctx.mine.has(id)
        ? "mine"
        : ctx.owners.has(id)
          ? "league"
          : ["QB", "RB", "WR", "TE", "K", "DEF"].includes(
                ctx.players.get(id)?.position || "",
              )
            ? "free_agent"
            : "none";
      if (RANK[r] < RANK[relevance]) relevance = r;
    }
    return { ...item, relevance, players };
  });
}
