import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  capabilities: {}
});

describe("job manager", () => {
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
