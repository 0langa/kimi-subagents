import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function json<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

interface McpManifest { mcpServers: Record<string, { command: string; args: string[]; cwd?: string }> }
interface PluginManifest { name: string; version: string; description: string; skills?: string }

describe("provider UX contract", () => {
  it("launches the same server file from Claude and Codex", async () => {
    const claude = await json<McpManifest>(".mcp.json");
    const codex = await json<McpManifest>(".codex-mcp.json");
    expect(claude.mcpServers["kimi-subagents"]?.command).toBe("node");
    expect(codex.mcpServers["kimi-subagents"]?.command).toBe("node");
    expect(claude.mcpServers["kimi-subagents"]?.args).toEqual(["${CLAUDE_PLUGIN_ROOT}/dist/server.mjs"]);
    expect(codex.mcpServers["kimi-subagents"]?.args).toEqual(["dist/server.mjs"]);
    expect(codex.mcpServers["kimi-subagents"]?.cwd).toBe("./");
  });

  it("keeps both provider manifests on the same name, version and description", async () => {
    const claude = await json<PluginManifest>(".claude-plugin/plugin.json");
    const codex = await json<PluginManifest>(".codex-plugin/plugin.json");
    const pkg = await json<{ version: string }>("package.json");
    const forge = await readFile("forge.yaml", "utf8");
    expect(codex.name).toBe(claude.name);
    expect(codex.version).toBe(claude.version);
    expect(codex.description).toBe(claude.description);
    expect(claude.version).toBe(pkg.version);
    expect(forge).toContain(`version: ${pkg.version}`);
  });

  it("ships the runtime assets both providers depend on", async () => {
    for (const asset of ["dist/server.mjs", "assets/shell-guard.sh", "skills/kimi-subagents/SKILL.md"]) {
      await expect(access(asset)).resolves.toBeUndefined();
    }
    const gitignore = await readFile(".gitignore", "utf8");
    expect(gitignore).not.toMatch(/^assets\/?$/m);
  });

  it("documents every session mode and auto budget in the shared skill", async () => {
    const skill = await readFile("skills/kimi-subagents/SKILL.md", "utf8");
    for (const mode of ["off", "manual", "ask", "auto"]) expect(skill).toContain(`\`${mode}\``);
    expect(skill).toContain("Maximum three Kimi jobs per user request");
    expect(skill).toContain("Mode switches affect future jobs only");
    expect(skill).toContain("Do not use or suggest goal mode");
    expect(skill).toContain("identical for Codex and Claude Code");
  });

  it("documents the execute flags the server accepts", async () => {
    const skill = await readFile("skills/kimi-subagents/SKILL.md", "utf8");
    for (const flag of ["allowCommit", "allowDelete", "allowDirty"]) expect(skill).toContain(flag);
  });

  it("keeps Claude commands as thin wrappers over the shared skill", async () => {
    for (const command of ["commands/kimi-mode.md", "commands/kimi-status.md"]) {
      const body = await readFile(command, "utf8");
      expect(body).toContain("kimi-subagents");
      expect(body).toMatch(/skill/i);
    }
  });

  it("refuses to pin a catalog to a commit that is not published", async () => {
    const local = await mkdtemp(path.join(os.tmpdir(), "kimi-catalog-unpublished-"));
    roots.push(local);
    const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { encoding: "utf8" })).stdout.trim();
    const published = (await execFileAsync("git", ["rev-parse", "origin/main"], { encoding: "utf8" })).stdout.trim();
    if (head === published) return;
    await expect(execFileAsync(process.execPath, ["scripts/create-dev-catalog.mjs", head], {
      env: { ...process.env, LOCALAPPDATA: local }
    })).rejects.toThrow();
  });

  it("generates both exact-SHA local catalogs outside repository", async () => {
    const local = await mkdtemp(path.join(os.tmpdir(), "kimi-catalog-"));
    roots.push(local);
    const sha = (await execFileAsync("git", ["rev-parse", "origin/main"], { encoding: "utf8" })).stdout.trim();
    await execFileAsync(process.execPath, ["scripts/create-dev-catalog.mjs", sha], { env: { ...process.env, LOCALAPPDATA: local } });
    const root = path.join(local, "kimi-subagents", "dev-marketplace");
    const codex = await json<{ name: string; plugins: Array<{ source: { sha: string } }> }>(path.join(root, ".agents", "plugins", "marketplace.json"));
    const claude = await json<{ name: string; plugins: Array<{ source: { sha: string } }> }>(path.join(root, ".claude-plugin", "marketplace.json"));
    expect(codex.name).toBe("kimi-subagents-dev");
    expect(claude.name).toBe("kimi-subagents-dev");
    expect(codex.plugins[0]?.source.sha).toBe(sha);
    expect(claude.plugins[0]?.source.sha).toBe(sha);
  });
});
