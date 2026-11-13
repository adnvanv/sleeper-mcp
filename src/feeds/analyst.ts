/**
 * AI article reader (Google Gemini). For your players and the advisor's top
 * pickups it reads the recent news we collect (Rotowire blurbs, ESPN) plus
 * games played and Sleeper's projection, and returns a short structured
 * take: outlook vs the projection, role, health, a summary and key points.
 *
 * It never changes projections (a backtest found Sleeper's own projections
 * hard to beat); the read is shown as context and as reasons/cautions.
 *
 * Models are tried in order; one that is overloaded, missing or out of quota
 * is skipped for a while. Google Search grounding is used when the key's plan
 * allows it, and turned off for six hours when it's rejected.
 */

import { fetchJson } from "./http.js";

export interface AiRead {
  outlook: "up" | "steady" | "down";
  confidence: "low" | "medium" | "high";
  role: string;
  health: string;
  summary: string;
  key_points: string[];
}

export interface StoredRead {
  read: AiRead;
  at: string;
  model: string;
  fingerprint: string;
  searched: boolean;
  sources: { title: string; url: string }[];
}

export const DEFAULT_MODELS = ["gemini-flash-latest", "gemini-3-flash-preview", "gemini-3.1-flash-lite"];

const SCHEMA = {
  type: "OBJECT",
  properties: {
    outlook: { type: "STRING", enum: ["up", "steady", "down"] },
    confidence: { type: "STRING", enum: ["low", "medium", "high"] },
    role: { type: "STRING" },
    health: { type: "STRING" },
    summary: { type: "STRING" },
    key_points: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["outlook", "confidence", "role", "health", "summary", "key_points"],
};

const API = "https://generativelanguage.googleapis.com/v1beta/models";

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Pull the first JSON object out of a reply (for grounded calls, which can't use JSON mode). */
export function parseJsonReply(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("No JSON in reply");
  return JSON.parse(text.slice(start, end + 1));
}

export function validRead(x: unknown): AiRead {
  const r = x as Partial<AiRead>;
  const pick = <T extends string>(v: unknown, allowed: T[], fallback: T): T =>
    allowed.includes(v as T) ? (v as T) : fallback;
  if (!r || typeof r.summary !== "string" || !r.summary.trim()) throw new Error("Reply missing summary");
  return {
    outlook: pick(r.outlook, ["up", "steady", "down"], "steady"),
    confidence: pick(r.confidence, ["low", "medium", "high"], "low"),
    role: String(r.role || "").slice(0, 80),
    health: String(r.health || "").slice(0, 80),
    summary: r.summary.trim().slice(0, 500),
    key_points: (Array.isArray(r.key_points) ? r.key_points : []).map(String).slice(0, 3).map((s) => s.slice(0, 180)),
  };
}

export class GeminiAnalyst {
  private readonly models: string[];
  private benchedUntil = new Map<string, number>();
  private searchOffUntil = 0;

  constructor(
    private readonly apiKey: string,
    models: string[] = DEFAULT_MODELS,
  ) {
    this.models = models;
  }

  private async call(model: string, prompt: string, search: boolean) {
    const body = search
      ? {
          contents: [{ role: "user", parts: [{ text: `${prompt}\n\nReply with ONLY a JSON object with keys outlook ("up"|"steady"|"down"), confidence ("low"|"medium"|"high"), role, health, summary, key_points (array of up to 3 strings).` }] }],
          tools: [{ google_search: {} }],
          generationConfig: { temperature: 0.2 },
        }
      : {
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, responseMimeType: "application/json", responseSchema: SCHEMA },
        };
    const res = await fetch(`${API}/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25 * 1000),
    });
    const json = (await res.json().catch(() => ({}))) as {
      error?: { code?: number; message?: string };
      candidates?: { content?: { parts?: { text?: string }[] }; groundingMetadata?: { groundingChunks?: { web?: { uri?: string; title?: string } }[] } }[];
    };
    if (!res.ok || json.error) throw new ApiError(res.status, json.error?.message || `Gemini ${res.status}`);
    const cand = json.candidates?.[0];
    const text = (cand?.content?.parts || []).map((p) => p.text || "").join("");
    const sources = (cand?.groundingMetadata?.groundingChunks || [])
      .map((c) => ({ title: c.web?.title || "", url: c.web?.uri || "" }))
      .filter((s) => s.url)
      .slice(0, 5);
    return { read: validRead(search ? parseJsonReply(text) : JSON.parse(text)), sources };
  }

  /** Try each model (and search when allowed) until one answers. */
  async analyze(prompt: string): Promise<Omit<StoredRead, "fingerprint">> {
    const now = Date.now();
    let lastError: unknown;
    for (const model of this.models) {
      if ((this.benchedUntil.get(model) || 0) > now) continue;
      const tries = this.searchOffUntil > now ? [false] : [true, false];
      for (const search of tries) {
        try {
          const { read, sources } = await this.call(model, prompt, search);
          return { read, model, searched: search, sources, at: new Date().toISOString() };
        } catch (error) {
          lastError = error;
          const status = error instanceof ApiError ? error.status : 0;
          if (search && (status === 429 || status === 400 || status === 403)) {
            this.searchOffUntil = now + 6 * 60 * 60 * 1000; // plan doesn't include search
            continue;
          }
          if (status === 404) this.benchedUntil.set(model, now + 24 * 60 * 60 * 1000);
          else if (status === 429) this.benchedUntil.set(model, now + 10 * 60 * 1000);
          else if (status === 503 || status === 500) this.benchedUntil.set(model, now + 2 * 60 * 1000);
          else if (status === 0) this.benchedUntil.set(model, now + 10 * 60 * 1000); // timed out / unreachable
          break; // next model
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error("No Gemini model available");
  }

  get searchEnabled() {
    return this.searchOffUntil <= Date.now();
  }
}

export interface PromptInput {
  name: string;
  position: string;
  team: string | null;
  today: string;
  week: number;
  format: string;
  injury: string | null;
  projectedPpg: number | null;
  weekProjection: number | null;
  opponent: string | null;
  games: { week: number; points: number; snap_share: number | null; targets: number; carries: number }[];
  news: { published: string; source: string; title: string; summary: string }[];
  market: { adds_24h: number; drops_24h: number };
}

export function buildPrompt(p: PromptInput): string {
  const games = p.games.length
    ? p.games
        .map((g) => `wk${g.week}: ${g.points} pts, ${g.snap_share != null ? `${Math.round(g.snap_share * 100)}% snaps, ` : ""}${g.targets} targets, ${g.carries} carries`)
        .join("; ")
    : "none recorded";
  const news = p.news.length
    ? p.news.map((n) => `- ${n.published.slice(0, 10)} ${n.source}: ${n.title}${n.summary ? ` ${n.summary.slice(0, 400)}` : ""}`).join("\n")
    : "- (no recent news)";
  return [
    `You are a careful fantasy football analyst. League: ${p.format}. Today is ${p.today}, NFL week ${p.week}.`,
    `Player: ${p.name}, ${p.position}, ${p.team || "free agent"}${p.injury ? `, listed ${p.injury}` : ""}.`,
    `Sleeper projection: ${p.projectedPpg ?? "n/a"} pts a game rest of season; ${p.weekProjection ?? "n/a"} this week${p.opponent ? ` (${p.opponent})` : ""}.`,
    `Games played this season (league scoring): ${games}.`,
    `Sleeper-wide in the last 24h: ${p.market.adds_24h} adds, ${p.market.drops_24h} drops.`,
    `Recent news (newest first):\n${news}`,
    "",
    "Judge his rest-of-season fantasy outlook relative to the Sleeper projection: \"up\" if the news and usage suggest he'll beat it, \"down\" if worse, else \"steady\". Base everything on the information above (and search results if available). State only facts that appear there; don't compute new statistics. role: his current role in a few words. health: current health in a few words. summary: at most two sentences. key_points: up to three short points.",
  ].join("\n");
}
