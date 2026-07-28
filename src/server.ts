import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export const SERVER_VERSION = "0.1.0";

export async function main(): Promise<void> {
  const server = new McpServer({ name: "kimi-subagents", version: SERVER_VERSION });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\\\", "/")}`) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown startup failure";
    process.stderr.write(`[kimi-subagents] ${message}\n`);
    process.exitCode = 1;
  });
}
