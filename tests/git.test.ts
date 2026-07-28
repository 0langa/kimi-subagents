import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { workspacePatch } from "../src/git.js";
import { runFile } from "../src/process.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function repository(): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "kimi-patch-"));
  roots.push(workspace);
  await runFile("git", ["init", "-q", workspace]);
  await runFile("git", ["-C", workspace, "config", "user.email", "test@example.invalid"]);
  await runFile("git", ["-C", workspace, "config", "user.name", "Kimi Subagents Test"]);
  await writeFile(path.join(workspace, "tracked.txt"), "before\n");
  await runFile("git", ["-C", workspace, "add", "-A"]);
  await runFile("git", ["-C", workspace, "commit", "-q", "-m", "baseline"]);
  return workspace;
}

describe("workspace patch", () => {
  it("returns nothing for a clean workspace", async () => {
    expect(await workspacePatch(await repository())).toBeUndefined();
  });

  it("captures tracked edits and untracked additions", async () => {
    const workspace = await repository();
    await writeFile(path.join(workspace, "tracked.txt"), "after\n");
    await writeFile(path.join(workspace, "created.txt"), "brand new\n");
    const patch = await workspacePatch(workspace);
    expect(patch).toContain("tracked.txt");
    expect(patch).toContain("+after");
    expect(patch).toContain("created.txt");
    expect(patch).toContain("+brand new");
  });

  it("includes a delegated commit range", async () => {
    const workspace = await repository();
    const baseline = (await runFile("git", ["-C", workspace, "rev-parse", "HEAD"])).stdout.trim();
    await writeFile(path.join(workspace, "tracked.txt"), "committed\n");
    await runFile("git", ["-C", workspace, "commit", "-qam", "delegated"]);
    const patch = await workspacePatch(workspace, baseline);
    expect(patch).toContain("+committed");
  });

  it("returns nothing outside a Git repository", async () => {
    const plain = await mkdtemp(path.join(os.tmpdir(), "kimi-plain-"));
    roots.push(plain);
    expect(await workspacePatch(plain)).toBeUndefined();
  });
});
