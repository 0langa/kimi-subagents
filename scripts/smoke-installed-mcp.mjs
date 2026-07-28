import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const pluginRoot = path.resolve(process.argv[2] ?? ".");
if (!existsSync(path.join(pluginRoot, "dist", "server.mjs"))) throw new Error("Installed plugin root missing dist/server.mjs");
const transport = new StdioClientTransport({ command: "node", args: ["dist/server.mjs"], cwd: pluginRoot, stderr: "pipe" });
const client = new Client({ name: "kimi-subagents-install-smoke", version: "0.1.0" });
try {
  await client.connect(transport);
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  const expected = ["kimi_cancel", "kimi_list", "kimi_preflight", "kimi_restore", "kimi_result", "kimi_start", "kimi_status"];
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error(`Unexpected tools: ${names.join(", ")}`);
  const preflight = await client.callTool({ name: "kimi_preflight", arguments: { workspace: process.cwd() } });
  if (preflight.isError) throw new Error("kimi_preflight returned an error");
  process.stdout.write(`${JSON.stringify({ pluginRoot, tools: names, preflight: preflight.structuredContent }, null, 2)}\n`);
} finally {
  await client.close();
}
