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
}

export const DEFAULT_DASHBOARD_HOST = "127.0.0.1";
export const DEFAULT_DASHBOARD_PORT = 3030;

/**
 * Real environment variables win over values from the .env file.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  fileValues: Record<string, string> = loadEnvFile(),
): SleeperConfig {
  const pick = (key: string) =>
    (env[key] || fileValues[key] || "").trim() || undefined;
  const port = Number(pick("DASHBOARD_PORT"));
  return {
    username: pick("SLEEPER_USERNAME"),
    leagueId: pick("SLEEPER_LEAGUE_ID"),
    dashboardHost: pick("DASHBOARD_HOST") || DEFAULT_DASHBOARD_HOST,
    dashboardPort:
      Number.isInteger(port) && port > 0 && port < 65536
        ? port
        : DEFAULT_DASHBOARD_PORT,
  };
}

export const config = loadConfig();
