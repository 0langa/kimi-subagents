import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { runFile } from "./process.js";
import type { ChangedFile } from "./types.js";

export interface WorkingTreeEntry extends ChangedFile { fingerprint: string }

function parseStatus(status: string): ChangedFile[] {
  return status.split(/\r?\n/).filter(Boolean).map((line) => ({
    status: line.slice(0, 2).trim() || "?",
    path: line.slice(3).trim().replaceAll("\\", "/")
  }));
}

async function fingerprint(workspace: string, relative: string): Promise<string> {
  try {
    const content = await readFile(path.resolve(workspace, relative));
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return "[missing]";
  }
}

export async function workingTreeSnapshot(workspace: string, status: string): Promise<WorkingTreeEntry[]> {
  return Promise.all(parseStatus(status).map(async (file) => ({ ...file, fingerprint: await fingerprint(workspace, file.path) })));
}

export async function isGitRepository(workspace: string): Promise<boolean> {
  try {
    await runFile("git", ["-C", workspace, "rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

export async function gitOutput(workspace: string, args: string[], timeout = 30_000): Promise<string> {
  return (await runFile("git", ["-C", workspace, ...args], undefined, timeout)).stdout;
}

export async function gitHead(workspace: string): Promise<string | undefined> {
  try { return (await gitOutput(workspace, ["rev-parse", "HEAD"])).trim(); } catch { return undefined; }
}

export async function gitDirty(workspace: string): Promise<boolean> {
  if (!(await isGitRepository(workspace))) return false;
  return (await gitOutput(workspace, ["status", "--porcelain=v1", "--untracked-files=all"])).length > 0;
}

export async function changedFiles(
  workspace: string,
  baselineCommit?: string,
  baseline: WorkingTreeEntry[] = []
): Promise<{ files: ChangedFile[]; preExistingFiles: ChangedFile[]; summary: string; head?: string }> {
  if (!(await isGitRepository(workspace))) return { files: [], preExistingFiles: [], summary: "Non-Git workspace; file attribution unavailable." };
  const status = await gitOutput(workspace, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const current = await workingTreeSnapshot(workspace, status);
  const prior = new Map(baseline.map((file) => [file.path, file]));
  const preExistingFiles = current
    .filter((file) => {
      const before = prior.get(file.path);
      return before?.status === file.status && before.fingerprint === file.fingerprint;
    })
    .map(({ status: fileStatus, path: filePath }) => ({ status: fileStatus, path: filePath }));
  const preExistingPaths = new Set(preExistingFiles.map((file) => file.path));
  let files = current
    .filter((file) => !preExistingPaths.has(file.path))
    .map(({ status: fileStatus, path: filePath }) => ({ status: fileStatus, path: filePath }));
  const head = await gitHead(workspace);
  if (baselineCommit && head && baselineCommit !== head) {
    const committed = (await gitOutput(workspace, ["diff", "--name-status", `${baselineCommit}..${head}`]))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [fileStatus = "?", ...parts] = line.split("\t");
        return { status: fileStatus, path: parts.slice(-1)[0]?.replaceAll("\\", "/") ?? "" };
      })
      .filter((file) => file.path);
    const merged = new Map(files.map((file) => [file.path, file]));
    for (const file of committed) merged.set(file.path, file);
    files = [...merged.values()];
  }
  let summary = files.length === 0 ? "No job-attributed working-tree changes." : `${files.length} job-attributed working-tree path(s) changed.`;
  if (preExistingFiles.length > 0) summary += ` ${preExistingFiles.length} pre-existing dirty path(s) unchanged.`;
  if (baselineCommit && head && baselineCommit !== head) {
    const stat = (await gitOutput(workspace, ["diff", "--stat", `${baselineCommit}..${head}`])).trim();
    summary += ` Commit range ${baselineCommit.slice(0, 8)}..${head.slice(0, 8)}.${stat ? ` ${stat}` : ""}`;
  } else if (files.length > 0) {
    const stat = (await gitOutput(workspace, ["diff", "--stat"])).trim();
    if (stat) summary += ` ${stat}`;
  }
  return { files, preExistingFiles, summary, head };
}

export function normalizeRelative(workspace: string, target: string): string {
  const relative = path.relative(path.resolve(workspace), path.resolve(target));
  if (!relative || relative === ".") return ".";
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Path escapes workspace");
  return relative.replaceAll("\\", "/");
}
