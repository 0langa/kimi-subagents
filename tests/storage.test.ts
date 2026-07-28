import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RecordStore } from "../src/storage.js";
import type { JobRecord } from "../src/types.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function record(id: string): JobRecord {
  const now = new Date().toISOString();
  return {
    id, ownerPid: process.pid, status: "running", jobType: "analyze", workspace: "C:\\fixture", additionalRoots: [],
    taskSummary: "test", allowDirty: false, allowCommit: false, createdAt: now, updatedAt: now, retries: 0,
    blockedActions: [], changedFiles: [], recoveryAvailable: false, acceptedRisk: "allow-unless-blocked"
  };
}

describe("record store", () => {
  it("serializes concurrent atomic updates for one streamed job", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kimi-store-"));
    roots.push(root);
    const store = new RecordStore(root);
    const id = "77777777-7777-4777-8777-777777777777";
    const value = record(id);
    await Promise.all(Array.from({ length: 50 }, (_, index) => store.save({ ...value, progress: `chunk-${index}` })));
    const stored = await store.get(id);
    expect(stored?.progress).toMatch(/^chunk-\d+$/);
    expect(stored?.id).toBe(id);
  });
});
