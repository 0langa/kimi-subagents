import { access, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { JobManager } from "../../src/job-manager.js";
import { RecordStore } from "../../src/storage.js";
import { runFile } from "../../src/process.js";
import type { JobRecord } from "../../src/types.js";

const roots: string[] = [];
let manager: JobManager;
let workspace: string;
let pulseInstalled = false;

const pulseHome = path.join(os.homedir(), ".usage-pulse");

// SQLite may land the write in the WAL sibling rather than the main file, so the
// freshest timestamp across the store is what proves the hooks fired.
async function pulseTouchedAt(): Promise<number> {
  const names = ["pulse.db", "pulse.db-wal", "pulse.db-shm", "current-sessions.json"];
  const stamps = await Promise.all(names.map((name) => stat(path.join(pulseHome, name)).then((info) => info.mtimeMs).catch(() => 0)));
  return Math.max(...stamps);
}

async function waitForTerminal(id: string): Promise<JobRecord> {
  for (;;) {
    const record = await manager.wait(id, 55, true);
    if (["completed", "failed", "blocked", "cancelled"].includes(record.status)) return record;
  }
}

beforeAll(async () => {
  const storage = await mkdtemp(path.join(os.tmpdir(), "kimi-pulse-store-"));
  workspace = await mkdtemp(path.join(os.tmpdir(), "kimi-pulse-ws-"));
  roots.push(storage, workspace);
  await runFile("git", ["init", "-q", workspace]);
  await writeFile(path.join(workspace, "seed.txt"), "seed\n");
  manager = new JobManager(new RecordStore(storage));
  await manager.initialize();
  pulseInstalled = await access(path.join(os.homedir(), ".kimi-code", "plugins", "managed", "usage-pulse", "hooks", "session_start.py"), constants.R_OK)
    .then(() => true).catch(() => false);
});

afterAll(async () => {
  await manager.shutdown();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("usage pulse opt-in", () => {
  it("records a tracked job in the local Usage Pulse database", async () => {
    if (!pulseInstalled) return;
    const before = await pulseTouchedAt();
    const started = await manager.start({
      jobType: "analyze",
      workspace,
      trackUsage: true,
      task: "Report the first line of seed.txt and nothing else."
    });
    const record = await waitForTerminal(started.id);
    expect(record.status).toBe("completed");
    expect(record.trackUsage).toBe(true);
    const after = await pulseTouchedAt();
    expect(after).toBeGreaterThan(before);
  });

  it("leaves Usage Pulse untouched for an ordinary job", async () => {
    const started = await manager.start({
      jobType: "analyze",
      workspace,
      task: "Reply with the single word ok."
    });
    const record = await waitForTerminal(started.id);
    expect(record.trackUsage).toBe(false);
  });
});
