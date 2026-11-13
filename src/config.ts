import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = join(__dirname, "..", ".env");

/**
 * Parse a simple KEY=VALUE .env file. Lines starting with # are ignored,
 * and surrounding quotes on values are stripped.
 */
export function parseEnvFile(contents: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function loadEnvFile(): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(ENV_FILE, "utf-8"));
  } catch {
    return {};
  }
}

export interface SleeperConfig {
  username?: string;
  leagueId?: string;
  /** Dashboard bind address. 127.0.0.1 = this machine only; 0.0.0.0 = LAN. */
  dashboardHost: string;
  dashboardPort: number;
  /** HTTP MCP endpoint (for claude.ai / phone). Keep on 127.0.0.1 behind Funnel. */
  mcpHttpHost: string;
  mcpHttpPort: number;
  /** Secret path segment: the endpoint is /mcp/<secret>. */
  mcpHttpSecret?: string;
  /** Dashboard live polling, in seconds, while one of your players is in a game. */
  livePollSeconds: number;
  /** Google Gemini key for the AI article reader (optional). */
  geminiApiKey?: string;
  /** Comma-separated Gemini models to try in order (optional). */
  geminiModels?: string[];
}

export const DEFAULT_DASHBOARD_HOST = "127.0.0.1";
export const DEFAULT_DASHBOARD_PORT = 3030;
export const DEFAULT_MCP_HTTP_HOST = "127.0.0.1";
export const DEFAULT_MCP_HTTP_PORT = 3031;
export const DEFAULT_LIVE_POLL_SECONDS = 2;

/** Seconds between live polls: at least 1, at most 60. */
function parseSeconds(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(60, Math.max(1, n)) : fallback;
}

function parsePort(value: string | undefined, fallback: number): number {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback;
}

/**
 * Real environment variables win over values from the .env file.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  fileValues: Record<string, string> = loadEnvFile(),
): SleeperConfig {
  const pick = (key: string) =>
    (env[key] || fileValues[key] || "").trim() || undefined;
  return {
    username: pick("SLEEPER_USERNAME"),
    leagueId: pick("SLEEPER_LEAGUE_ID"),
    dashboardHost: pick("DASHBOARD_HOST") || DEFAULT_DASHBOARD_HOST,
    dashboardPort: parsePort(pick("DASHBOARD_PORT"), DEFAULT_DASHBOARD_PORT),
    mcpHttpHost: pick("MCP_HTTP_HOST") || DEFAULT_MCP_HTTP_HOST,
    mcpHttpPort: parsePort(pick("MCP_HTTP_PORT"), DEFAULT_MCP_HTTP_PORT),
    mcpHttpSecret: pick("MCP_HTTP_SECRET"),
    geminiApiKey: pick("GEMINI_API_KEY"),
    geminiModels: pick("GEMINI_MODELS")?.split(",").map((m) => m.trim()).filter(Boolean),
    livePollSeconds: parseSeconds(
      pick("LIVE_POLL_SECONDS"),
      DEFAULT_LIVE_POLL_SECONDS,
    ),
  };
}

export const config = loadConfig();
