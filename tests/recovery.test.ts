import { mkdtemp, open, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runFile } from "../src/process.js";
import { assertCheckpointLimits, RecoveryManager } from "../src/recovery.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function gitFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "kimi-recovery-"));
  roots.push(root);
  await runFile("git", ["init", "-q", root]);
  await runFile("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  await runFile("git", ["-C", root, "config", "user.name", "Kimi Subagents Test"]);
  await writeFile(path.join(root, "fixture.txt"), "before\n");
  await runFile("git", ["-C", root, "add", "fixture.txt"]);
  await runFile("git", ["-C", root, "commit", "-q", "-m", "fixture"]);
  return root;
}

describe("recovery checkpoints", () => {
  it("allows exactly 100,000 files and refuses the next file", () => {
    expect(() => assertCheckpointLimits(100_000, 0)).not.toThrow();
    expect(() => assertCheckpointLimits(100_001, 0)).toThrow("100,000 files");
  });

  it("restores selected tracked paths only after exact confirmation", async () => {
    const workspace = await gitFixture();
    const storage = await mkdtemp(path.join(os.tmpdir(), "kimi-recovery-store-"));
    roots.push(storage);
    const recovery = new RecoveryManager(storage);
    const jobId = "11111111-1111-4111-8111-111111111111";
    await recovery.create(jobId, workspace);
    await recovery.backupBeforeWrite(jobId, [path.join(workspace, "fixture.txt"), "relative-only.txt"]);
    await writeFile(path.join(workspace, "fixture.txt"), "after\n");
    await expect(recovery.restore(jobId, ["fixture.txt"], "wrong")).rejects.toThrow("Explicit confirmation required");
    await recovery.restore(jobId, ["fixture.txt"], `RESTORE ${jobId}`);
    expect(await readFile(path.join(workspace, "fixture.txt"), "utf8")).toBe("before\n");
  });

  it("refuses checkpoints above 1 GiB", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "kimi-large-"));
    const storage = await mkdtemp(path.join(os.tmpdir(), "kimi-large-store-"));
    roots.push(workspace, storage);
    const handle = await open(path.join(workspace, "large.bin"), "w");
    await handle.truncate(1024 ** 3 + 1);
    await handle.close();
    await expect(new RecoveryManager(storage).create("22222222-2222-4222-8222-222222222222", workspace)).rejects.toThrow("1 GiB");
  });
});
