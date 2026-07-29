import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { JobManager } from "../src/job-manager.js";
import { runFile } from "../src/process.js";
import { RecordStore } from "../src/storage.js";
import type { JobRecord, RunResult } from "../src/types.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(): Promise<{ workspace: string; manager: JobManager }> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "kimi-manager-"));
  const storage = await mkdtemp(path.join(os.tmpdir(), "kimi-manager-store-"));
  roots.push(workspace, storage);
  await writeFile(path.join(workspace, "fixture.txt"), "before\n");
  const manager = new JobManager(new RecordStore(storage));
  await manager.initialize();
  return { workspace, manager };
}

async function waitFor(manager: JobManager, id: string, predicate: (record: JobRecord) => boolean, timeout = 10_000): Promise<JobRecord> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const record = await manager.get(id);
    if (predicate(record)) return record;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${id}: ${JSON.stringify(await manager.get(id))}`);
}

const success = (id: string): RunResult => ({
  sessionId: `session-${id}`,
  stopReason: "end_turn",
  finalMessage: "done",
  blockedActions: [],
  shellCommands: [],
  toolViolations: [],
  capabilities: {}
});

describe("job manager", () => {
  it("retries one transient ACP failure and then completes", async () => {
    const { workspace, manager } = await fixture();
    let calls = 0;
    manager.runner.run = async (id) => {
      calls += 1;
      if (calls === 1) throw new Error("ECONNRESET");
      return success(id);
    };
    const started = await manager.start({ task: "retry", jobType: "analyze", workspace });
    const finished = await waitFor(manager, started.id, (candidate) => candidate.status === "completed");
    expect(calls).toBe(2);
    expect(finished.retries).toBe(1);
  });

  it("marks stale running jobs failed during initialization", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "kimi-stale-"));
    const storage = await mkdtemp(path.join(os.tmpdir(), "kimi-stale-store-"));
    roots.push(workspace, storage);
    const store = new RecordStore(storage);
    const now = new Date().toISOString();
    const id = "99999999-9999-4999-8999-999999999999";
    await store.save({
      id,
      ownerPid: 2_147_483_647,
      status: "running",
      jobType: "execute",
      workspace,
      additionalRoots: [],
      taskSummary: "stale",
      allowDirty: false,
      allowCommit: false,
      allowDelete: false, allowNetwork: false, allowSubagents: false, readOnlyRoots: [], allowInterpreters: [], trackUsage: false, effort: "high", stallSeconds: 900,
      createdAt: now,
      updatedAt: now,
      retries: 0,
      blockedActions: [],
      shellCommands: [],
      toolViolations: [],
      changedFiles: [],
      recoveryAvailable: false,
      acceptedRisk: "allow-unless-blocked"
    });
    const manager = new JobManager(store);
    await manager.initialize();
    const recovered = await manager.get(id);
    expect(recovered.status).toBe("failed");
    expect(recovered.error).toContain("Host process stopped");
  });

  it("cancels a job that stops reporting progress", async () => {
    const { workspace, manager } = await fixture();
    let cancelled = false;
    manager.runner.run = async (id, _input, callbacks) => {
      await callbacks?.onProgress?.("working");
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      return { ...success(id), stopReason: cancelled ? "cancelled" : "end_turn" };
    };
    manager.runner.cancel = async () => { cancelled = true; return true; };
    const started = await manager.start({ task: "stall", jobType: "analyze", workspace, stallSeconds: 1 });
    const finished = await waitFor(manager, started.id, (candidate) => candidate.status === "failed", 12_000);
    expect(cancelled).toBe(true);
    expect(finished.error).toContain("without Kimi activity");
  }, 20_000);

  it("records the deterministic default effort per job type", async () => {
    const { workspace, manager } = await fixture();
    manager.runner.run = async (id) => success(id);
    const analyze = await manager.start({ task: "a", jobType: "analyze", workspace });
    const execute = await manager.start({ task: "b", jobType: "execute", workspace });
    expect(analyze.effort).toBe("low");
    expect(execute.effort).toBe("high");
    expect(analyze.stallSeconds).toBe(900);
    for (const job of [analyze, execute]) {
      await waitFor(manager, job.id, (candidate) => ["completed", "failed", "blocked", "cancelled"].includes(candidate.status));
    }
  });

  it("carries parent context into a follow-up job", async () => {
    const { workspace, manager } = await fixture();
    const tasks: string[] = [];
    manager.runner.run = async (id, input) => {
      tasks.push(input.task);
      return success(id);
    };
    const parent = await manager.start({ task: "write the parser", jobType: "execute", workspace, allowDelete: true });
    await waitFor(manager, parent.id, (candidate) => candidate.status === "completed");
    const child = await manager.followUp(parent.id, "the parser test fails on empty input; fix it");
    const finished = await waitFor(manager, child.id, (candidate) => candidate.status === "completed");

    expect(finished.parentJobId).toBe(parent.id);
    expect(finished.allowDelete).toBe(true);
    expect(finished.jobType).toBe("execute");
    expect(tasks[1]).toContain(`CONTINUATION OF JOB ${parent.id}`);
    expect(tasks[1]).toContain("write the parser");
    expect(tasks[1]).toContain("the parser test fails on empty input");
  });

  it("refuses enabled project-local Kimi MCP servers", async () => {
    const { workspace, manager } = await fixture();
    await mkdir(path.join(workspace, ".kimi-code"), { recursive: true });
    await writeFile(path.join(workspace, ".kimi-code", "mcp.json"), JSON.stringify({ mcpServers: { unsafe: { command: "unsafe" } } }));
    await expect(manager.start({ task: "test", jobType: "analyze", workspace })).rejects.toThrow("Project-local Kimi MCP servers are blocked");
  });

  it("refuses dirty execute trees without explicit override", async () => {
    const { workspace, manager } = await fixture();
    await runFile("git", ["init", "-q", workspace]);
    await runFile("git", ["-C", workspace, "config", "user.email", "test@example.invalid"]);
    await runFile("git", ["-C", workspace, "config", "user.name", "Kimi Subagents Test"]);
    await runFile("git", ["-C", workspace, "add", "fixture.txt"]);
    await runFile("git", ["-C", workspace, "commit", "-q", "-m", "fixture"]);
    await writeFile(path.join(workspace, "fixture.txt"), "dirty\n");
    const record = await manager.start({ task: "edit", jobType: "execute", workspace });
    const finished = await waitFor(manager, record.id, (candidate) => candidate.status === "blocked");
    expect(finished.error).toContain("dirty");
    expect(finished.recoveryAvailable).toBe(false);
  }, 15_000);

  it("separates unchanged pre-existing dirty paths from job output", async () => {
    const { workspace, manager } = await fixture();
    await runFile("git", ["init", "-q", workspace]);
    await runFile("git", ["-C", workspace, "config", "user.email", "test@example.invalid"]);
    await runFile("git", ["-C", workspace, "config", "user.name", "Kimi Subagents Test"]);
    await runFile("git", ["-C", workspace, "add", "fixture.txt"]);
    await runFile("git", ["-C", workspace, "commit", "-q", "-m", "fixture"]);
    await writeFile(path.join(workspace, "fixture.txt"), "user-dirty\n");
    manager.runner.run = async (id) => {
      await writeFile(path.join(workspace, "override.txt"), "created-by-kimi");
      return success(id);
    };
    const record = await manager.start({ task: "edit", jobType: "execute", workspace, allowDirty: true });
    const finished = await waitFor(manager, record.id, (candidate) => candidate.status === "completed");
    expect(finished.changedFiles).toEqual([{ status: "??", path: "override.txt" }]);
    expect(finished.preExistingChangedFiles).toEqual([{ status: "M", path: "fixture.txt" }]);
  });

  it("attributes files changed in a delegated local commit", async () => {
    const { workspace, manager } = await fixture();
    await runFile("git", ["init", "-q", workspace]);
    await runFile("git", ["-C", workspace, "config", "user.email", "test@example.invalid"]);
    await runFile("git", ["-C", workspace, "config", "user.name", "Kimi Subagents Test"]);
    await runFile("git", ["-C", workspace, "add", "fixture.txt"]);
    await runFile("git", ["-C", workspace, "commit", "-q", "-m", "fixture"]);
    manager.runner.run = async (id) => {
      await writeFile(path.join(workspace, "fixture.txt"), "committed\n");
      await runFile("git", ["-C", workspace, "add", "fixture.txt"]);
      await runFile("git", ["-C", workspace, "commit", "-q", "-m", "delegated"]);
      return success(id);
    };
    const record = await manager.start({ task: "commit", jobType: "execute", workspace, allowCommit: true });
    const finished = await waitFor(manager, record.id, (candidate) => candidate.status === "completed");
    expect(finished.changedFiles).toEqual([{ status: "M", path: "fixture.txt" }]);
    expect(finished.resultingCommit).not.toBe(finished.baselineCommit);
  });

  it("allows two jobs but only one execute writer per workspace", async () => {
    const { workspace, manager } = await fixture();
    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let calls = 0;
    manager.runner.run = async (id) => {
      calls += 1;
      if (calls === 1) await gate;
      return success(id);
    };
    const first = await manager.start({ task: "one", jobType: "execute", workspace, allowDirty: true });
    const second = await manager.start({ task: "two", jobType: "execute", workspace, allowDirty: true });
    await waitFor(manager, first.id, (record) => record.status === "running");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await manager.get(second.id)).status).toBe("queued");
    releaseFirst?.();
    await waitFor(manager, second.id, (record) => record.status === "completed");
    expect(calls).toBe(2);
  });

  it("runs at most two jobs globally and queues the third", async () => {
    const { workspace, manager } = await fixture();
    const secondWorkspace = await mkdtemp(path.join(os.tmpdir(), "kimi-manager-second-"));
    const thirdWorkspace = await mkdtemp(path.join(os.tmpdir(), "kimi-manager-third-"));
    roots.push(secondWorkspace, thirdWorkspace);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let active = 0;
    let maximum = 0;
    manager.runner.run = async (id) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await gate;
      active -= 1;
      return success(id);
    };
    const first = await manager.start({ task: "one", jobType: "analyze", workspace });
    const second = await manager.start({ task: "two", jobType: "analyze", workspace: secondWorkspace });
    const third = await manager.start({ task: "three", jobType: "analyze", workspace: thirdWorkspace });
    await waitFor(manager, first.id, (record) => record.status === "running");
    await waitFor(manager, second.id, (record) => record.status === "running");
    expect((await manager.get(third.id)).status).toBe("queued");
    expect(maximum).toBe(2);
    release?.();
    await waitFor(manager, third.id, (record) => record.status === "completed");
  });

  it("persists redacted task metadata", async () => {
    const prior = process.env.TEST_MANAGER_SECRET_TOKEN;
    process.env.TEST_MANAGER_SECRET_TOKEN = "manager-secret-12345";
    try {
      const { workspace, manager } = await fixture();
      manager.runner.run = async (id) => success(id);
      const record = await manager.start({ task: "use manager-secret-12345", jobType: "analyze", workspace });
      expect(record.taskSummary).not.toContain("manager-secret-12345");
      expect(record.taskSummary).toContain("[REDACTED]");
      await waitFor(manager, record.id, (candidate) => candidate.status === "completed");
    } finally {
      if (prior === undefined) delete process.env.TEST_MANAGER_SECRET_TOKEN; else process.env.TEST_MANAGER_SECRET_TOKEN = prior;
    }
  });
});
