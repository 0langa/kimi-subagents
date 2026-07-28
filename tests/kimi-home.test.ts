import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { IsolatedKimiHome } from "../src/kimi-home.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("isolated Kimi home", () => {
  it("links credentials, omits MCP config, and removes only isolation data", async () => {
    const source = await mkdtemp(path.join(os.tmpdir(), "kimi-home-source-"));
    const base = await mkdtemp(path.join(os.tmpdir(), "kimi-home-base-"));
    roots.push(source, base);
    await writeFile(path.join(source, "device_id"), "device");
    await writeFile(path.join(source, "source-sentinel.txt"), "keep");
    await writeFile(path.join(source, "config.toml"), [
      'default_model = "kimi-code/test"',
      '[[hooks]]',
      'event = "BeforeAgent"',
      'command = "unsafe-hook"',
      '[providers."managed:kimi-code"]',
      'type = "kimi"',
      'api_key = ""',
      'base_url = "https://example.invalid"',
      '[providers."managed:kimi-code".oauth]',
      'storage = "file"',
      'key = "kimi-code"',
      '[models."kimi-code/test"]',
      'provider = "managed:kimi-code"',
      'model = "test"',
      'max_context_size = 1000'
    ].join("\n"));
    await import("node:fs/promises").then(({ mkdir }) => mkdir(path.join(source, "credentials")));
    await writeFile(path.join(source, "credentials", "auth.json"), "synthetic");
    await writeFile(path.join(source, "mcp.json"), "{\"mcpServers\":{\"unsafe\":{}}}");
    const isolated = new IsolatedKimiHome(base, source);
    const home = await isolated.prepare("test-job");
    expect(await readFile(path.join(home, "credentials", "auth.json"), "utf8")).toBe("synthetic");
    const config = await readFile(path.join(home, "config.toml"), "utf8");
    expect(config).toContain('[models."kimi-code/test"]');
    expect(config).not.toContain("hooks");
    expect(config).not.toContain("unsafe-hook");
    await expect(readFile(path.join(home, "mcp.json"), "utf8")).rejects.toThrow();
    await writeFile(path.join(home, "session.json"), "transient");
    await isolated.dispose("test-job");
    expect(await readFile(path.join(source, "source-sentinel.txt"), "utf8")).toBe("keep");
    expect(await readFile(path.join(source, "credentials", "auth.json"), "utf8")).toBe("synthetic");
  });
});
