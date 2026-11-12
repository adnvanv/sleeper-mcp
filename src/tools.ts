import { z } from "zod";
import { Tool } from "@modelcontextprotocol/sdk/types.js";

// Input validation schemas
export const GetUserInfoSchema = z.object({
  username_or_id: z.string().describe("Sleeper username or user ID"),
});

export const GetUserLeaguesSchema = z.object({
  user_id: z.string().describe("Sleeper user ID"),
  season: z
    .string()
    .optional()
    .describe("NFL season year (defaults to current season)"),
  sport: z
    .string()
    .optional()
    .default("nfl")
    .describe("Sport (nfl is currently the only supported option)"),
});

export const GetLeagueInfoSchema = z.object({
  league_id: z.string().describe("Sleeper league ID"),
});

export const GetLeagueRostersSchema = z.object({
  league_id: z.string().describe("Sleeper league ID"),
  include_player_details: z
    .boolean()
    .optional()
    .default(true)
    .describe("Include detailed player information"),
});

export const GetLeagueUsersSchema = z.object({
  league_id: z.string().describe("Sleeper league ID"),
});

export const GetCurrentMatchupsSchema = z.object({
  league_id: z.string().describe("Sleeper league ID"),
  week: z
    .number()
    .optional()
    .describe("NFL week number (if not provided, uses current week)"),
});

export const GetMatchupDetailsSchema = z.object({
  league_id: z.string().describe("Sleeper league ID"),
  user_id: z.string().describe("User ID to get matchup for"),
  week: z
    .number()
    .optional()
    .describe("NFL week number (if not provided, uses current week)"),
});

export const SearchPlayersSchema = z.object({
  query: z.string().describe("Search term for player names"),
  limit: z
    .number()
    .min(1)
    .max(50)
    .optional()
    .default(10)
    .describe("Maximum number of results to return"),
});

export const GetTrendingPlayersSchema = z.object({
  type: z
    .enum(["add", "drop"])
    .optional()
    .default("add")
    .describe("Type of trending players"),
  lookback_hours: z
    .number()
    .optional()
    .default(24)
    .describe("Hours to look back for trending data"),
  limit: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .default(25)
    .describe("Maximum number of results"),
});

export const GetTrendingFreeAgentsSchema = z.object({
  league_id: z.string().describe("Sleeper league ID"),
  position: z
    .string()
    .optional()
    .describe("Only this position (QB, RB, WR, TE, K, DEF)"),
  lookback_hours: z
    .number()
    .min(1)
    .max(168)
    .optional()
    .default(24)
    .describe("Hours of add activity to look back over"),
  limit: z
    .number()
    .min(1)
    .max(50)
    .optional()
    .default(15)
    .describe("Maximum number of free agents to return"),
});

export const GetPlayerDetailsSchema = z.object({
  player_ids: z
    .array(z.string())
    .describe("Array of player IDs to get details for"),
});

export const ResearchPlayerStatusSchema = z.object({
  player_name: z.string().describe("Full name of the player to research"),
  team: z
    .string()
    .optional()
    .describe("Player's current team (helps with search accuracy)"),
});

export const AnalyzeLineupSchema = z.object({
  league_id: z.string().describe("Sleeper league ID"),
  user_id: z.string().describe("User ID whose lineup to analyze"),
  week: z
    .number()
    .optional()
    .describe("Week to analyze (current week if not specified)"),
});

export const GetWaiverSuggestionsSchema = z.object({
  league_id: z.string().describe("Sleeper league ID"),
  user_id: z.string().describe("User ID to get suggestions for"),
  position: z
    .string()
    .optional()
    .describe("Specific position to focus on (QB, RB, WR, TE, K, DEF)"),
});

export const GetTransactionsSchema = z.object({
  league_id: z.string().describe("Sleeper league ID"),
  week: z
    .number()
    .optional()
    .describe("Week to get transactions for (current week if not specified)"),
});

export const ComparePlayersSchema = z.object({
  player1_id: z.string().describe("First player ID to compare"),
  player2_id: z.string().describe("Second player ID to compare"),
  context: z
    .string()
    .optional()
    .describe(
      'Additional context for comparison (e.g., "this week matchup", "ROS value")',
    ),
});

export const GetStartSitAdviceSchema = z.object({
  league_id: z.string().describe("Sleeper league ID"),
  user_id: z.string().describe("User ID to get advice for"),
  position: z
    .string()
    .optional()
    .describe("Specific position to get advice for"),
  week: z
    .number()
    .optional()
    .describe("Week to analyze (current week if not specified)"),
});

export const ClearCacheSchema = z.object({
  confirm: z
    .boolean()
    .optional()
    .default(false)
    .describe("Set to true to confirm cache clearing"),
});

// Tool definitions
export const tools: Tool[] = [
  {
    name: "get_user_info",
    description: "Get Sleeper user information by username or user ID",
    inputSchema: {
      type: "object",
      properties: {
        username_or_id: {
          type: "string",
          description:
            "Sleeper username or user ID (optional; defaults to SLEEPER_USERNAME)",
        },
      },
    },
  },
  {
    name: "get_user_leagues",
    description: "Get all leagues for a specific user in a given season",
    inputSchema: {
      type: "object",
      properties: {
        user_id: {
          type: "string",
          description:
            "Sleeper user ID or username (optional; defaults to SLEEPER_USERNAME)",
        },
        season: {
          type: "string",
          description: "NFL season year (defaults to current season)",
        },
        sport: {
          type: "string",
          description: "Sport (nfl is currently the only supported option)",
          default: "nfl",
        },
      },
    },
  },
  {
    name: "get_league_info",
    description:
      "Get detailed information about a specific league including scoring settings and roster positions",
    inputSchema: {
      type: "object",
      properties: {
        league_id: {
          type: "string",
          description:
            "Sleeper league ID (optional; defaults to SLEEPER_LEAGUE_ID or your only league this season)",
        },
      },
    },
  },
  {
    name: "get_league_rosters",
    description:
      "Get all team rosters in a league with optional detailed player information",
    inputSchema: {
      type: "object",
      properties: {
        league_id: {
          type: "string",
          description:
            "Sleeper league ID (optional; defaults to SLEEPER_LEAGUE_ID or your only league this season)",
        },
        include_player_details: {
          type: "boolean",
          description: "Include detailed player information",
          default: true,
        },
      },
    },
  },
  {
    name: "get_league_users",
    description:
      "Get all users/managers in a league with their team names and roles",
    inputSchema: {
      type: "object",
      properties: {
        league_id: {
          type: "string",
          description:
            "Sleeper league ID (optional; defaults to SLEEPER_LEAGUE_ID or your only league this season)",
        },
      },
    },
  },
  {
    name: "get_current_matchups",
    description:
      "Get current week matchups for a league showing who is playing against whom",
    inputSchema: {
      type: "object",
      properties: {
        league_id: {
          type: "string",
          description:
            "Sleeper league ID (optional; defaults to SLEEPER_LEAGUE_ID or your only league this season)",
        },
        week: {
          type: "number",
          description: "NFL week number (if not provided, uses current week)",
        },
      },
    },
  },
  {
    name: "get_matchup_details",
    description:
      "Get detailed matchup information for a specific user including opponent lineups",
    inputSchema: {
      type: "object",
      properties: {
        league_id: {
          type: "string",
          description:
            "Sleeper league ID (optional; defaults to SLEEPER_LEAGUE_ID or your only league this season)",
        },
        user_id: {
          type: "string",
          description:
            "User ID to get matchup for or username (optional; defaults to SLEEPER_USERNAME)",
        },
        week: {
          type: "number",
          description: "NFL week number (if not provided, uses current week)",
        },
      },
    },
  },
  {
    name: "get_nfl_state",
    description:
      "Get current NFL season state including current week, season type, and important dates",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "search_players",
    description: "Search for NFL players in the Sleeper database by name",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search term for player names",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return",
          minimum: 1,
          maximum: 50,
          default: 10,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_trending_players",
    description:
      "Get trending players based on recent add/drop activity across all Sleeper leagues",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["add", "drop"],
          description: "Type of trending players",
          default: "add",
        },
        lookback_hours: {
          type: "number",
          description: "Hours to look back for trending data",
          default: 24,
        },
        limit: {
          type: "number",
          description: "Maximum number of results",
          minimum: 1,
          maximum: 100,
          default: 25,
        },
      },
    },
  },
  {
    name: "get_trending_free_agents",
    description:
      "Find players trending as adds across Sleeper who are NOT on any roster in your league (including IR and taxi), at positions your league starts. Best answer to 'who should I pick up?'",
    inputSchema: {
      type: "object",
      properties: {
        league_id: {
          type: "string",
          description:
            "Sleeper league ID (optional; defaults to SLEEPER_LEAGUE_ID or your only league this season)",
        },
        position: {
          type: "string",
          description: "Only this position (QB, RB, WR, TE, K, DEF)",
        },
        lookback_hours: {
          type: "number",
          description: "Hours of add activity to look back over",
          minimum: 1,
          maximum: 168,
          default: 24,
        },
        limit: {
          type: "number",
          description: "Maximum number of free agents to return",
          minimum: 1,
          maximum: 50,
          default: 15,
        },
      },
    },
  },
  {
    name: "get_player_details",
    description:
      "Get detailed information for specific player IDs including position, team, and injury status",
    inputSchema: {
      type: "object",
      properties: {
        player_ids: {
          type: "array",
          items: {
            type: "string",
          },
          description: "Array of player IDs to get details for",
        },
      },
      required: ["player_ids"],
    },
  },
  {
    name: "research_player_status",
    description:
      "Research a player's current status using web search to find injury updates, news, and playing time information",
    inputSchema: {
      type: "object",
      properties: {
        player_name: {
          type: "string",
          description: "Full name of the player to research",
        },
        team: {
          type: "string",
          description: "Player's current team (helps with search accuracy)",
        },
      },
      required: ["player_name"],
    },
  },
  {
    name: "analyze_lineup",
    description:
      "Analyze a user's lineup and provide recommendations for start/sit decisions and potential improvements",
    inputSchema: {
      type: "object",
      properties: {
        league_id: {
          type: "string",
          description:
            "Sleeper league ID (optional; defaults to SLEEPER_LEAGUE_ID or your only league this season)",
        },
        user_id: {
          type: "string",
          description:
            "User ID whose lineup to analyze or username (optional; defaults to SLEEPER_USERNAME)",
        },
        week: {
          type: "number",
          description: "Week to analyze (current week if not specified)",
        },
      },
    },
  },
  {
    name: "get_waiver_suggestions",
    description:
      "Get waiver wire pickup suggestions based on trends, injuries, and team needs",
    inputSchema: {
      type: "object",
      properties: {
        league_id: {
          type: "string",
          description:
            "Sleeper league ID (optional; defaults to SLEEPER_LEAGUE_ID or your only league this season)",
        },
        user_id: {
          type: "string",
          description:
            "User ID to get suggestions for or username (optional; defaults to SLEEPER_USERNAME)",
        },
        position: {
          type: "string",
          description: "Specific position to focus on (QB, RB, WR, TE, K, DEF)",
        },
      },
    },
  },
  {
    name: "get_transactions",
    description:
      "Get recent transactions (trades, waivers, free agent pickups) in a league",
    inputSchema: {
      type: "object",
      properties: {
        league_id: {
          type: "string",
          description:
            "Sleeper league ID (optional; defaults to SLEEPER_LEAGUE_ID or your only league this season)",
        },
        week: {
          type: "number",
          description:
            "Week to get transactions for (current week if not specified)",
        },
      },
    },
  },
  {
    name: "compare_players",
    description:
      "Compare two players head-to-head with analysis of their fantasy value and current situations",
    inputSchema: {
      type: "object",
      properties: {
        player1_id: {
          type: "string",
          description: "First player ID to compare",
        },
        player2_id: {
          type: "string",
          description: "Second player ID to compare",
        },
        context: {
          type: "string",
          description:
            'Additional context for comparison (e.g., "this week matchup", "ROS value")',
        },
      },
      required: ["player1_id", "player2_id"],
    },
  },
  {
    name: "get_start_sit_advice",
    description:
      "Get specific start/sit advice for players on a user's roster based on matchups and current status",
    inputSchema: {
      type: "object",
      properties: {
        league_id: {
          type: "string",
          description:
            "Sleeper league ID (optional; defaults to SLEEPER_LEAGUE_ID or your only league this season)",
        },
        user_id: {
          type: "string",
          description:
            "User ID to get advice for or username (optional; defaults to SLEEPER_USERNAME)",
        },
        position: {
          type: "string",
          description: "Specific position to get advice for",
        },
        week: {
          type: "number",
          description: "Week to analyze (current week if not specified)",
        },
      },
    },
  },
  {
    name: "clear_cache",
    description:
      "Clear the persistent player data cache to force fresh data retrieval on next request",
    inputSchema: {
      type: "object",
      properties: {
        confirm: {
          type: "boolean",
          description: "Set to true to confirm cache clearing",
          default: false,
        },
      },
    },
  },
];

export type ToolInput =
  | z.infer<typeof GetUserInfoSchema>
  | z.infer<typeof GetUserLeaguesSchema>
  | z.infer<typeof GetLeagueInfoSchema>
  | z.infer<typeof GetLeagueRostersSchema>
  | z.infer<typeof GetLeagueUsersSchema>
  | z.infer<typeof GetCurrentMatchupsSchema>
  | z.infer<typeof GetMatchupDetailsSchema>
  | z.infer<typeof SearchPlayersSchema>
  | z.infer<typeof GetTrendingPlayersSchema>
  | z.infer<typeof GetTrendingFreeAgentsSchema>
  | z.infer<typeof GetPlayerDetailsSchema>
  | z.infer<typeof ResearchPlayerStatusSchema>
  | z.infer<typeof AnalyzeLineupSchema>
  | z.infer<typeof GetWaiverSuggestionsSchema>
  | z.infer<typeof GetTransactionsSchema>
  | z.infer<typeof ComparePlayersSchema>
  | z.infer<typeof GetStartSitAdviceSchema>
  | z.infer<typeof ClearCacheSchema>;
