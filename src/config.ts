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
  };
}

export const config = loadConfig();
