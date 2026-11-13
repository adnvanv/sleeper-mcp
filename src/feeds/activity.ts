/**
 * Activity stream: every play involving one of your players (from ESPN's
 * play-by-play) plus news about them, newest first.
 *
 * ESPN play text names players as "J.Chase", "Ja.Chase" or "A.St. Brown";
 * only the newest play carries athlete IDs. So players are matched by ESPN ID
 * when present and otherwise by that name pattern, limited to plays from the
 * player's own game.
 */

import type { SleeperPlayer } from "../types.js";
import type { TaggedNewsItem } from "./news.js";

export interface ActivityItem {
  id: string;
  kind: "play" | "news";
  at: string;
  player_id: string;
  name: string;
  position: string | null;
  team: string | null;
  starter: boolean;
  headline: string;
  detail: string;
  clock: string | null;
  scoring: boolean;
  url: string | null;
}

interface EspnPlay {
  id: string;
  text?: string;
  type?: { text?: string };
  period?: { number?: number };
  clock?: { displayValue?: string };
  scoringPlay?: boolean;
  wallclock?: string;
  modified?: string;
  participants?: { athlete?: { id?: string } }[];
}

export interface EspnSummary {
  drives?: {
    previous?: { plays?: EspnPlay[] }[];
    current?: { plays?: EspnPlay[] };
  };
}

export function summaryPlays(summary: EspnSummary): EspnPlay[] {
  const seen = new Set<string>();
  const plays = [
    ...(summary.drives?.previous || []).flatMap((d) => d.plays || []),
    ...(summary.drives?.current?.plays || []),
  ];
  return plays.filter((p) => p.id && !seen.has(p.id) && seen.add(p.id));
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Regex for how ESPN writes a player's name in play text. */
export function playNamePattern(p: Pick<SleeperPlayer, "first_name" | "last_name">): RegExp | null {
  const first = (p.first_name || "").replace(/[^A-Za-z]/g, "");
  const last = (p.last_name || "").trim();
  if (!first || !last) return null;
  // Suffixes ("Walker III") are usually left off in play text.
  const lastCore = last.replace(/\s+(Jr\.?|Sr\.?|II|III|IV|V)$/i, "");
  return new RegExp(
    `(?<![A-Za-z.])${escape(first[0])}[a-z]{0,2}\\.\\s?${escape(lastCore).replace(/\\\.\s*/g, "\\.\\s?")}(?![a-z])`,
  );
}

function periodLabel(n?: number): string {
  if (!n) return "";
  return n <= 4 ? `Q${n}` : n === 5 ? "OT" : `${n - 4}OT`;
}

/** The part of the play that stood: text after a "REVERSED" replay ruling. */
export function effectiveText(text: string): string {
  const parts = text.split(/REVERSED\.?/i);
  return parts[parts.length - 1].trim() || text;
}

/**
 * Short headline from the player's point of view, e.g. "Completion · 11 yds"
 * for the passer, "Catch · 11 yds" for the receiver, "Rush · -1 yd".
 */
export function playHeadline(play: EspnPlay, pattern?: RegExp | null): string {
  const text = effectiveText(play.text || "");
  let type = play.type?.text || "Play";
  const yards = text.match(/for (-?\d+) yards?/i)?.[1];
  const noGain = /for no gain/i.test(text);
  const incomplete = /pass incomplete/i.test(text);
  const passer = pattern ? new RegExp(pattern.source + "\\s+pass", "").test(text) : false;
  const target = pattern ? new RegExp("pass[^.]*?(?:to|for)\\s+" + pattern.source).test(text) : false;
  if (/no play/i.test(text) && /penalty/i.test(text)) return "Penalty · no play";
  if (incomplete) type = passer ? "Incompletion" : target ? "Target · incomplete" : type;
  else if (/intercepted/i.test(text) && passer) type = "Interception thrown";
  else if (/touchdown/i.test(type) || /touchdown/i.test(text)) {
    type = passer ? "TD pass" : target ? "Receiving TD" : /rush/i.test(type) ? "Rushing TD" : "Touchdown";
  } else if (passer && /pass/i.test(type)) type = "Completion";
  else if (target && /pass/i.test(type)) type = "Catch";
  if (incomplete) return type;
  if (yards != null) return `${type} · ${yards} yd${Math.abs(Number(yards)) === 1 ? "" : "s"}`;
  if (noGain) return `${type} · no gain`;
  return type;
}

export interface RosterPlayer {
  player_id: string;
  player: SleeperPlayer;
  starter: boolean;
}

/**
 * Activity items for one game's plays. `players` should be your rostered
 * players whose NFL team is in this game.
 */
export function playActivity(
  plays: EspnPlay[],
  players: RosterPlayer[],
  gameStart: string,
): ActivityItem[] {
  const matchers = players
    .filter((r) => r.player.position !== "DEF")
    .map((r) => ({
      ...r,
      espn: String((r.player as { espn_id?: unknown }).espn_id ?? ""),
      pattern: playNamePattern(r.player),
    }));
  const out: ActivityItem[] = [];
  for (const play of plays) {
    const text = (play.text || "").trim();
    if (!text) continue;
    const ids = new Set((play.participants || []).map((x) => String(x.athlete?.id ?? "")));
    for (const m of matchers) {
      const hit = (m.espn && ids.has(m.espn)) || (m.pattern && m.pattern.test(text));
      if (!hit) continue;
      const p = m.player;
      out.push({
        id: `play:${play.id}:${m.player_id}`,
        kind: "play",
        at: play.wallclock || play.modified || gameStart,
        player_id: m.player_id,
        name: `${p.first_name} ${p.last_name}`.trim(),
        position: p.position || null,
        team: p.team || null,
        starter: m.starter,
        headline: playHeadline(play, m.pattern),
        detail: text,
        clock: [periodLabel(play.period?.number), play.clock?.displayValue].filter(Boolean).join(" ") || null,
        scoring: !!play.scoringPlay,
        url: null,
      });
    }
  }
  return out;
}

/** News about your players as activity items. */
export function newsActivity(
  news: TaggedNewsItem[],
  mine: Set<string>,
  starters: Set<string>,
): ActivityItem[] {
  return news
    .filter((n) => n.relevance === "mine")
    .flatMap((n) =>
      n.players
        .filter((p) => mine.has(p.player_id))
        // player blurbs always count; general columns only if they name him
        .filter(
          (p) =>
            n.source === "Rotowire" ||
            n.title
              .toLowerCase()
              .includes(p.name.replace(/\s+(Jr\.?|Sr\.?|II|III|IV|V)$/i, "").split(" ").slice(-1)[0].toLowerCase()),
        )
        .slice(0, 1)
        .map((p) => ({
          id: `news:${n.id}`,
          kind: "news" as const,
          at: n.published,
          player_id: p.player_id,
          name: p.name,
          position: p.position,
          team: p.team,
          starter: starters.has(p.player_id),
          headline: n.title,
          detail: n.summary,
          clock: null,
          scoring: false,
          url: n.url,
        })),
    );
}

/** Newest first; plays with equal times keep play order (later play first). */
export function mergeActivity(items: ActivityItem[], max = 60): ActivityItem[] {
  const byId = new Map<string, ActivityItem & { order: number }>();
  items.forEach((item, order) => byId.set(item.id, { ...item, order }));
  return [...byId.values()]
    .sort((a, b) => b.at.localeCompare(a.at) || b.order - a.order)
    .slice(0, max)
    .map(({ order: _order, ...item }) => item);
}
