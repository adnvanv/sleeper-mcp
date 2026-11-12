import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { tools } from "./tools.js";
import { handleToolCall } from "./handlers.js";

export const SERVER_NAME = "sleeper-mcp";
export const SERVER_VERSION = "1.2.0";

/**
 * Builds an MCP server with all Sleeper tools registered. Used by both the
 * stdio entry point (Claude Desktop) and the HTTP entry point (claude.ai
 * custom connector / phone app).
 */
export function createMcpServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await handleToolCall(name, args || {});
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error occurred";
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { success: false, error: errorMessage, tool: name },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }
  });

  server.onerror = (error) => {
    console.error("[MCP Server Error]", error);
  };

  return server;
}
