import path from "node:path";

import { runFile } from "./process.js";
import type { ChangedFile } from "./types.js";

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

export async function changedFiles(workspace: string, baselineCommit?: string): Promise<{ files: ChangedFile[]; summary: string; head?: string }> {
  if (!(await isGitRepository(workspace))) return { files: [], summary: "Non-Git workspace; file attribution unavailable." };
  const status = await gitOutput(workspace, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const files = status.split(/\r?\n/).filter(Boolean).map((line) => ({ status: line.slice(0, 2).trim() || "?", path: line.slice(3).trim() }));
  const head = await gitHead(workspace);
  let summary = files.length === 0 ? "Working tree clean." : `${files.length} working-tree path(s) changed.`;
  if (baselineCommit && head && baselineCommit !== head) {
    const stat = (await gitOutput(workspace, ["diff", "--stat", `${baselineCommit}..${head}`])).trim();
    summary += ` Commit range ${baselineCommit.slice(0, 8)}..${head.slice(0, 8)}.${stat ? ` ${stat}` : ""}`;
  } else if (files.length > 0) {
    const stat = (await gitOutput(workspace, ["diff", "--stat"])).trim();
    if (stat) summary += ` ${stat}`;
  }
  return { files: files.map((file) => ({ ...file, path: file.path.replaceAll("\\", "/") })), summary, head };
}

export function normalizeRelative(workspace: string, target: string): string {
  const relative = path.relative(path.resolve(workspace), path.resolve(target));
  if (!relative || relative === ".") return ".";
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Path escapes workspace");
  return relative.replaceAll("\\", "/");
}
