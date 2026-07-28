import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AcpRunner } from "../src/acp-runner.js";
import { RecoveryManager } from "../src/recovery.js";
import { ShellGuard } from "../src/shell-guard.js";

const roots: string[] = [];
const priorMode = process.env.FAKE_ACP_MODE;
afterEach(async () => {
  if (priorMode === undefined) delete process.env.FAKE_ACP_MODE; else process.env.FAKE_ACP_MODE = priorMode;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(withGuard = false) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "kimi-acp-"));
  const storage = await mkdtemp(path.join(os.tmpdir(), "kimi-acp-store-"));
  roots.push(workspace, storage);
  await writeFile(path.join(workspace, "fixture.txt"), "safe\n");
  const runner = new AcpRunner(
    new RecoveryManager(storage),
    process.execPath,
    [path.resolve("tests/fixtures/fake-acp.mjs")],
    undefined,
    withGuard ? new ShellGuard(path.join(storage, "guards")) : undefined
  );
  return { runner, workspace };
}

describe("ACP runner", () => {
  it("rejects a malformed ACP frame without hanging", async () => {
    process.env.FAKE_ACP_MODE = "malformed";
    const { runner, workspace } = await setup();
    await expect(runner.run("22222222-3333-4333-8333-333333333333", { task: "test", jobType: "analyze", workspace })).rejects.toThrow();
  });

  it("allows an ordinary command from a real-shaped permission payload", async () => {
    process.env.FAKE_ACP_MODE = "execute";
    const { runner, workspace } = await setup();
    const result = await runner.run("33333333-3333-4333-8333-333333333333", { task: "test", jobType: "execute", workspace });
    expect(result.finalMessage).toBe("permission:approve_once");
    expect(result.usage?.totalTokens).toBe(12);
    expect(result.blockedActions).toEqual([]);
  });

  it("denies command execution in analyze jobs", async () => {
    process.env.FAKE_ACP_MODE = "execute";
    const { runner, workspace } = await setup();
    const result = await runner.run("44444444-4444-4444-8444-444444444444", { task: "test", jobType: "analyze", workspace });
    expect(result.finalMessage).toBe("permission:reject");
    expect(result.blockedActions[0]?.reason).toContain("read-only-job");
    expect(result.blockedActions[0]?.source).toBe("acp-broker");
  });

  it("denies deletion requested through the shell", async () => {
    process.env.FAKE_ACP_MODE = "delete";
    const { runner, workspace } = await setup();
    const result = await runner.run("55555555-5555-4555-8555-555555555555", { task: "test", jobType: "execute", workspace });
    expect(result.finalMessage).toBe("permission:reject");
    expect(result.blockedActions[0]?.reason).toContain("deletion");
    expect(await readFile(path.join(workspace, "fixture.txt"), "utf8")).toBe("safe\n");
  });

  it("allows a relative Write inside the workspace", async () => {
    process.env.FAKE_ACP_MODE = "write";
    const { runner, workspace } = await setup();
    const result = await runner.run("77777777-7777-4777-8777-777777777777", { task: "test", jobType: "execute", workspace });
    expect(result.finalMessage).toBe("permission:approve_once");
  });

  it("denies an edit that targets a path outside the granted roots", async () => {
    process.env.FAKE_ACP_MODE = "escape";
    const { runner, workspace } = await setup();
    const result = await runner.run("88888888-8888-4888-8888-888888888888", { task: "test", jobType: "execute", workspace });
    expect(result.finalMessage).toBe("permission:reject");
    expect(result.blockedActions[0]?.reason).toContain("workspace-escape");
  });

  it("fails closed on a permission payload it cannot read", async () => {
    process.env.FAKE_ACP_MODE = "opaque";
    const { runner, workspace } = await setup();
    const result = await runner.run("99999999-9999-4999-8999-999999999999", { task: "test", jobType: "execute", workspace });
    expect(result.finalMessage).toBe("permission:reject");
    expect(result.blockedActions[0]?.reason).toContain("fail-closed");
  });

  it("installs the shell guard and reports its command log", async () => {
    process.env.FAKE_ACP_MODE = "execute";
    const { runner, workspace } = await setup(true);
    const result = await runner.run("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { task: "test", jobType: "execute", workspace });
    expect(result.finalMessage).toBe("permission:approve_once");
    expect(Array.isArray(result.shellCommands)).toBe(true);
  });

  it("records and cancels an unauthorised network tool call", async () => {
    process.env.FAKE_ACP_MODE = "network";
    const { runner, workspace } = await setup();
    const result = await runner.run("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", { task: "test", jobType: "analyze", workspace });
    expect(result.toolViolations).toHaveLength(1);
    expect(result.toolViolations[0]).toMatchObject({ tool: "FetchURL", cancelled: true });
  });

  it("permits a network tool call when the job delegated it", async () => {
    process.env.FAKE_ACP_MODE = "network";
    const { runner, workspace } = await setup();
    const result = await runner.run("cccccccc-cccc-4ccc-8ccc-cccccccccccc", { task: "test", jobType: "analyze", workspace, allowNetwork: true });
    expect(result.toolViolations).toEqual([]);
    expect(result.finalMessage).toBe("fetched");
  });

  it("cancels active session and process", async () => {
    process.env.FAKE_ACP_MODE = "delay";
    const { runner, workspace } = await setup();
    const jobId = "66666666-6666-4666-8666-666666666666";
    const pending = runner.run(jobId, { task: "wait", jobType: "analyze", workspace });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await runner.cancel(jobId)).toBe(true);
    await expect(pending).resolves.toMatchObject({ stopReason: "cancelled" });
  });
});
