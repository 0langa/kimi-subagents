import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { delegateEnv, watchToolCall, SUBAGENT_DISABLED_TIMEOUT_MS } from "../src/delegate-runtime.js";
import { usagePulseHooks } from "../src/kimi-home.js";
import type { StartJobInput } from "../src/types.js";

const base: StartJobInput = { task: "t", jobType: "execute", workspace: "C:\\fixture" };
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("delegate runtime environment", () => {
  it("disables subagents, cron, telemetry and auto-update by default", () => {
    const env = delegateEnv(base);
    expect(env.KIMI_SUBAGENT_TIMEOUT_MS).toBe(String(SUBAGENT_DISABLED_TIMEOUT_MS));
    expect(env.KIMI_DISABLE_CRON).toBe("1");
    expect(env.KIMI_DISABLE_TELEMETRY).toBe("1");
    expect(env.KIMI_CODE_NO_AUTO_UPDATE).toBe("1");
    expect(env.KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY).toBe("1");
    expect(env.KIMI_LOOP_MAX_STEPS_PER_TURN).toBe("200");
  });

  it("points Usage Pulse at the real home only when tracking is on", () => {
    expect(delegateEnv(base).USAGE_PULSE_HOME).toBeUndefined();
    const tracked = delegateEnv({ ...base, trackUsage: true }).USAGE_PULSE_HOME;
    expect(tracked).toBeDefined();
    expect(tracked).toContain(".usage-pulse");
  });

  it("raises the subagent timeout only when subagents are delegated", () => {
    const env = delegateEnv({ ...base, allowSubagents: true, maxSteps: 40 });
    expect(Number(env.KIMI_SUBAGENT_TIMEOUT_MS)).toBeGreaterThan(60_000);
    expect(env.KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY).toBe("2");
    expect(env.KIMI_LOOP_MAX_STEPS_PER_TURN).toBe("40");
  });
});

describe("self-approved tool watch", () => {
  it("cancels the job on an unauthorised network call", () => {
    expect(watchToolCall("FetchURL", base)).toMatchObject({ violation: true, cancel: true });
    expect(watchToolCall("WebSearch", base)).toMatchObject({ violation: true, cancel: true });
  });

  it("permits network calls when the job delegated them", () => {
    expect(watchToolCall("FetchURL", { ...base, allowNetwork: true })).toMatchObject({ violation: false, cancel: false });
  });

  it("records subagent, cron and goal attempts without cancelling", () => {
    for (const tool of ["Agent", "AgentSwarm", "CronCreate", "CreateGoal", "SetGoalBudget"]) {
      expect(watchToolCall(tool, base), tool).toMatchObject({ violation: true, cancel: false });
    }
    expect(watchToolCall("Agent", { ...base, allowSubagents: true })).toMatchObject({ violation: false });
  });

  it("ignores ordinary tools", () => {
    for (const tool of ["Bash", "Read", "Edit", "Write", "Grep", "TodoList"]) {
      expect(watchToolCall(tool, base), tool).toMatchObject({ violation: false, cancel: false });
    }
  });
});

describe("usage pulse opt-in", () => {
  it("returns nothing when Usage Pulse is not installed", async () => {
    const source = await mkdtemp(path.join(os.tmpdir(), "kimi-pulse-none-"));
    roots.push(source);
    expect(await usagePulseHooks(source)).toBe("");
  });

  it("emits hook entries pointed at the installed plugin", async () => {
    const source = await mkdtemp(path.join(os.tmpdir(), "kimi-pulse-"));
    roots.push(source);
    const hooks = path.join(source, "plugins", "managed", "usage-pulse", "hooks");
    await mkdir(hooks, { recursive: true });
    await writeFile(path.join(hooks, "session_start.py"), "# stub");
    const rendered = await usagePulseHooks(source);
    expect(rendered).toContain("[[hooks]]");
    expect(rendered).toContain('event = "SessionStart"');
    expect(rendered).toContain("--provider kimi");
    expect(rendered).toContain("usage-pulse/hooks/session_start.py");
    expect(rendered).not.toContain("\\\\");
  });

  it("is written into the isolated home only when requested", async () => {
    const { IsolatedKimiHome } = await import("../src/kimi-home.js");
    const source = await mkdtemp(path.join(os.tmpdir(), "kimi-home-src-"));
    const target = await mkdtemp(path.join(os.tmpdir(), "kimi-home-base-"));
    roots.push(source, target);
    await mkdir(path.join(source, "credentials"), { recursive: true });
    await writeFile(path.join(source, "credentials", "auth.json"), "synthetic");
    await writeFile(path.join(source, "config.toml"), [
      'default_model = "kimi-code/test"',
      '[providers."managed:kimi-code"]',
      'type = "kimi"',
      'api_key = ""',
      '[providers."managed:kimi-code".oauth]',
      'storage = "file"',
      'key = "kimi-code"',
      '[models."kimi-code/test"]',
      'provider = "managed:kimi-code"',
      'model = "test"'
    ].join("\n"));
    const pulse = path.join(source, "plugins", "managed", "usage-pulse", "hooks");
    await mkdir(pulse, { recursive: true });
    await writeFile(path.join(pulse, "session_start.py"), "# stub");

    const isolated = new IsolatedKimiHome(target, source);
    const plain = await isolated.prepare("plain-job");
    expect(await readFile(path.join(plain, "config.toml"), "utf8")).not.toContain("[[hooks]]");
    expect(await readFile(path.join(plain, "AGENTS.md"), "utf8")).toContain("Delegated Kimi worker rules");

    const tracked = await isolated.prepare("tracked-job", { trackUsage: true });
    expect(await readFile(path.join(tracked, "config.toml"), "utf8")).toContain("[[hooks]]");
  });
});
