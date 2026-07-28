import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("provider UX contract", () => {
  it("anchors Claude MCP launch to plugin root without changing Codex launch", async () => {
    const claude = JSON.parse(await readFile(".mcp.json", "utf8")) as { mcpServers: Record<string, { args: string[] }> };
    const codex = JSON.parse(await readFile(".codex-mcp.json", "utf8")) as { mcpServers: Record<string, { args: string[] }> };
    expect(claude.mcpServers["kimi-subagents"]?.args).toEqual(["${CLAUDE_PLUGIN_ROOT}/dist/server.mjs"]);
    expect(codex.mcpServers["kimi-subagents"]?.args).toEqual(["dist/server.mjs"]);
  });

  it("documents every session mode and auto budget", async () => {
    const skill = await readFile("skills/kimi-subagents/SKILL.md", "utf8");
    for (const mode of ["off", "manual", "ask", "auto"]) expect(skill).toContain(`\`${mode}\``);
    expect(skill).toContain("Maximum three Kimi jobs per user request");
    expect(skill).toContain("Mode switches affect future jobs only");
    expect(skill).toContain("Do not use or suggest goal mode");
  });

  it("generates both exact-SHA local catalogs outside repository", async () => {
    const local = await mkdtemp(path.join(os.tmpdir(), "kimi-catalog-"));
    roots.push(local);
    const sha = (await execFileAsync("git", ["rev-parse", "HEAD"], { encoding: "utf8" })).stdout.trim();
    await execFileAsync(process.execPath, ["scripts/create-dev-catalog.mjs", sha], { env: { ...process.env, LOCALAPPDATA: local } });
    const root = path.join(local, "kimi-subagents", "dev-marketplace");
    const codex = JSON.parse(await readFile(path.join(root, ".agents", "plugins", "marketplace.json"), "utf8")) as { name: string; plugins: Array<{ source: { sha: string } }> };
    const claude = JSON.parse(await readFile(path.join(root, ".claude-plugin", "marketplace.json"), "utf8")) as { name: string; plugins: Array<{ source: { sha: string } }> };
    expect(codex.name).toBe("kimi-subagents-dev");
    expect(claude.name).toBe("kimi-subagents-dev");
    expect(codex.plugins[0]?.source.sha).toBe(sha);
    expect(claude.plugins[0]?.source.sha).toBe(sha);
  });
});
