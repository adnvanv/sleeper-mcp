import { teamName } from "./season.js";
import type {
  SleeperLeagueUser,
  SleeperPlayer,
  SleeperRoster,
  SleeperTransaction,
} from "./types.js";

export interface FeedPlayer {
  player_id: string;
  name: string;
  position: string | null;
  team: string | null;
}

export interface FeedSide {
  roster_id: number;
  team_name: string;
  added: FeedPlayer[];
  dropped: FeedPlayer[];
  picks_received: string[];
  faab_received: number;
}

export interface FeedItem {
  transaction_id: string;
  type: "trade" | "waiver" | "free_agent" | "commissioner" | string;
  week: number;
  created: number;
  date: string;
  faab_bid: number | null;
  sides: FeedSide[];
  summary: string;
}

export function ordinal(n: number): string {
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${n}th`;
  return `${n}${{ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th"}`;
}

function toFeedPlayer(
  id: string,
  players: Map<string, SleeperPlayer>,
): FeedPlayer {
  const p = players.get(id);
  return {
    player_id: id,
    name: p ? `${p.first_name || ""} ${p.last_name || ""}`.trim() || id : id,
    position: p?.position || null,
    team: p?.team || null,
  };
}

const label = (p: FeedPlayer) =>
  `${p.name}${p.position ? ` (${p.position}${p.team ? `, ${p.team}` : ""})` : ""}`;

/**
 * Turn raw league transactions into a readable newest-first feed. Only
 * completed moves are kept; failed waiver claims are dropped.
 */
export function buildTransactionFeed(
  transactions: SleeperTransaction[],
  rosters: SleeperRoster[],
  users: SleeperLeagueUser[],
  players: Map<string, SleeperPlayer>,
): {
  items: FeedItem[];
  counts: Record<string, number>;
  by_team: { team_name: string; moves: number }[];
} {
  const userMap = new Map(users.map((u) => [u.user_id, u]));
  const nameOf = (rosterId: number) => {
    const r = rosters.find((x) => x.roster_id === rosterId);
    return r ? teamName(r, userMap.get(r.owner_id)) : `Team ${rosterId}`;
  };

  const seen = new Set<string>();
  const items: FeedItem[] = [];
  for (const t of transactions) {
    if (t.status !== "complete" || seen.has(t.transaction_id)) continue;
    seen.add(t.transaction_id);

    const rosterIds = [
      ...new Set([
        ...(t.roster_ids || []),
        ...Object.values(t.adds || {}),
        ...Object.values(t.drops || {}),
      ]),
    ];
    const sides: FeedSide[] = rosterIds.map((rid) => ({
      roster_id: rid,
      team_name: nameOf(rid),
      added: Object.entries(t.adds || {})
        .filter(([, r]) => r === rid)
        .map(([id]) => toFeedPlayer(id, players)),
      dropped: Object.entries(t.drops || {})
        .filter(([, r]) => r === rid)
        .map(([id]) => toFeedPlayer(id, players)),
      picks_received: (t.draft_picks || [])
        .filter((p) => p.owner_id === rid)
        .map(
          (p) =>
            `${p.season} ${ordinal(p.round)}${p.roster_id !== rid ? ` (from ${nameOf(p.roster_id)})` : ""}`,
        ),
      faab_received: (t.waiver_budget || [])
        .filter((b) => b.receiver === rid)
        .reduce((sum, b) => sum + b.amount, 0),
    }));

    const bid = t.settings?.waiver_bid ?? null;
    let summary: string;
    if (t.type === "trade") {
      summary =
        "Trade: " +
        sides
          .map((s) => {
            const got = [
              ...s.added.map(label),
              ...s.picks_received,
              ...(s.faab_received ? [`$${s.faab_received} FAAB`] : []),
            ];
            return `${s.team_name} gets ${got.join(", ") || "nothing"}`;
          })
          .join("; ");
    } else {
      summary = sides
        .map((s) => {
          const parts: string[] = [];
          if (s.added.length)
            parts.push(
              `added ${s.added.map(label).join(", ")}${bid ? ` ($${bid})` : ""}`,
            );
          if (s.dropped.length)
            parts.push(`dropped ${s.dropped.map(label).join(", ")}`);
          return `${s.team_name} ${parts.join(" and ") || "made a move"}`;
        })
        .join("; ");
    }

    items.push({
      transaction_id: t.transaction_id,
      type: t.type,
      week: t.leg,
      created: t.created,
      date: new Date(t.created).toISOString(),
      faab_bid: bid,
      sides,
      summary,
    });
  }

  items.sort((a, b) => b.created - a.created);

  const counts: Record<string, number> = {};
  const teamMoves = new Map<string, number>();
  for (const item of items) {
    counts[item.type] = (counts[item.type] || 0) + 1;
    for (const s of item.sides) {
      teamMoves.set(s.team_name, (teamMoves.get(s.team_name) || 0) + 1);
    }
  }
  const by_team = [...teamMoves.entries()]
    .map(([team_name, moves]) => ({ team_name, moves }))
    .sort((a, b) => b.moves - a.moves);

  return { items, counts, by_team };
}
