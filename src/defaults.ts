import { config as defaultConfig, type SleeperConfig } from "./config.js";
import { sleeperClient, type SleeperClient } from "./sleeper-client.js";

const USERNAME_TOOLS = new Set(["get_user_info"]);

const USER_ID_TOOLS = new Set([
  "get_user_leagues",
  "get_matchup_details",
  "analyze_lineup",
  "get_waiver_suggestions",
  "get_start_sit_advice",
]);

const LEAGUE_ID_TOOLS = new Set([
  "get_league_info",
  "get_league_rosters",
  "get_league_users",
  "get_current_matchups",
  "get_matchup_details",
  "analyze_lineup",
  "get_waiver_suggestions",
  "get_transactions",
  "get_start_sit_advice",
  "get_trending_free_agents",
]);

const SEASON_TOOLS = new Set(["get_user_leagues"]);

type Client = Pick<SleeperClient, "getUser" | "getUserLeagues" | "getNFLState">;

/**
 * Fills in username, user_id, league_id and season when a tool call leaves
 * them out, using SLEEPER_USERNAME / SLEEPER_LEAGUE_ID and the current season.
 * A user_id that isn't numeric is treated as a username and looked up.
 */
export class DefaultsResolver {
  private userIdCache = new Map<string, string>();

  constructor(
    private client: Client = sleeperClient,
    private cfg: SleeperConfig = defaultConfig,
  ) {}

  async apply(toolName: string, args: Record<string, any>) {
    const resolved = { ...args };

    if (USERNAME_TOOLS.has(toolName) && !resolved.username_or_id) {
      resolved.username_or_id = this.requireUsername();
    }

    if (SEASON_TOOLS.has(toolName) && !resolved.season) {
      resolved.season = (await this.client.getNFLState()).season;
    }

    if (USER_ID_TOOLS.has(toolName)) {
      resolved.user_id = await this.resolveUserId(resolved.user_id);
    }

    if (LEAGUE_ID_TOOLS.has(toolName) && !resolved.league_id) {
      resolved.league_id = await this.resolveLeagueId();
    }

    return resolved;
  }

  private requireUsername(): string {
    if (!this.cfg.username) {
      throw new Error(
        "No username given and SLEEPER_USERNAME is not set. Pass one explicitly or set SLEEPER_USERNAME.",
      );
    }
    return this.cfg.username;
  }

  async resolveUserId(userIdOrName?: string): Promise<string> {
    const value = userIdOrName?.trim() || this.requireUsername();
    if (/^\d+$/.test(value)) return value;

    const key = value.toLowerCase();
    const cached = this.userIdCache.get(key);
    if (cached) return cached;

    const user = await this.client.getUser(value);
    if (!user?.user_id) throw new Error(`Sleeper user "${value}" not found`);
    this.userIdCache.set(key, user.user_id);
    return user.user_id;
  }

  async resolveLeagueId(): Promise<string> {
    if (this.cfg.leagueId) return this.cfg.leagueId;

    const userId = await this.resolveUserId();
    const { season } = await this.client.getNFLState();
    const leagues =
      (await this.client.getUserLeagues(userId, "nfl", season)) || [];

    if (leagues.length === 1) return leagues[0].league_id;
    if (leagues.length === 0) {
      throw new Error(
        `No ${season} leagues found for ${this.cfg.username}. Pass league_id explicitly.`,
      );
    }
    const list = leagues.map((l) => `${l.name} (${l.league_id})`).join(", ");
    throw new Error(
      `Multiple leagues found; pass league_id or set SLEEPER_LEAGUE_ID. Leagues: ${list}`,
    );
  }
}

export const defaultsResolver = new DefaultsResolver();
