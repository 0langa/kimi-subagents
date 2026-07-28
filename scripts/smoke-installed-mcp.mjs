import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const pluginRoot = path.resolve(process.argv[2] ?? ".");
const required = ["dist/server.mjs", "assets/shell-guard.sh", "skills/kimi-subagents/SKILL.md"];
for (const relative of required) {
  if (!existsSync(path.join(pluginRoot, relative))) throw new Error(`Installed plugin root is missing ${relative}`);
}

const expected = ["kimi_cancel", "kimi_list", "kimi_preflight", "kimi_restore", "kimi_result", "kimi_start", "kimi_status"];

function launchSpec(manifestFile, provider) {
  const manifest = JSON.parse(readFileSync(path.join(pluginRoot, manifestFile), "utf8"));
  const configured = manifest.mcpServers?.["kimi-subagents"];
  if (!configured) throw new Error(`Installed plugin root missing ${provider} MCP configuration`);
  const expand = (value) => value.replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginRoot);
  return {
    provider,
    command: expand(configured.command),
    args: configured.args.map(expand),
    // Claude anchors on ${CLAUDE_PLUGIN_ROOT}; Codex launches the server with the
    // plugin directory as working directory, so both must resolve to the same file.
    cwd: provider === "codex" ? pluginRoot : process.cwd()
  };
}

const specs = [launchSpec(".mcp.json", "claude"), launchSpec(".codex-mcp.json", "codex")];
const report = [];

for (const spec of specs) {
  const transport = new StdioClientTransport({ command: spec.command, args: spec.args, cwd: spec.cwd, stderr: "pipe" });
  const client = new Client({ name: "kimi-subagents-install-smoke", version: "0.2.0" });
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error(`${spec.provider}: unexpected tools: ${names.join(", ")}`);
    const preflight = await client.callTool({ name: "kimi_preflight", arguments: { workspace: process.cwd() } });
    if (preflight.isError) throw new Error(`${spec.provider}: kimi_preflight returned an error`);
    report.push({ ...spec, tools: names, preflight: preflight.structuredContent });
  } finally {
    await client.close();
  }
}

process.stdout.write(`${JSON.stringify({ pluginRoot, providers: report }, null, 2)}\n`);
