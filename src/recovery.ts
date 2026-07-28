import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ToolCall, ToolCallUpdate } from "@agentclientprotocol/sdk";

import { gitHead, gitOutput, isGitRepository, normalizeRelative } from "./git.js";
import { runFile } from "./process.js";

const MAX_BYTES = 1024 ** 3;
const MAX_FILES = 100_000;
const DISPOSABLE = new Set(["node_modules", ".venv", "venv", "dist", "build", "target", ".cache", ".pytest_cache", ".mypy_cache", ".ruff_cache", "coverage"]);

export interface RecoveryManifest {
  jobId: string;
  workspace: string;
  createdAt: string;
  git: boolean;
  baselineHead?: string;
  baselineStatus?: string;
  copied: string[];
  absent: string[];
  bytes: number;
  files: number;
}

function disposable(relative: string): boolean {
  return relative.split(/[\\/]/).some((segment) => DISPOSABLE.has(segment.toLowerCase()));
}

async function walk(root: string, current = root): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const full = path.join(current, entry.name);
    const relative = path.relative(root, full);
    if (disposable(relative) || entry.name === ".git") continue;
    if (entry.isDirectory()) output.push(...await walk(root, full));
    else if (entry.isFile()) output.push(relative);
  }
  return output;
}

function parseStatusPaths(raw: string): string[] {
  return raw.split("\0").filter(Boolean).flatMap((entry) => {
    const value = entry.slice(3);
    return value.includes(" -> ") ? value.split(" -> ").slice(-1) : [value];
  });
}

async function copyCandidate(workspace: string, recoveryRoot: string, relative: string, manifest: RecoveryManifest): Promise<void> {
  if (disposable(relative)) return;
  const source = path.resolve(workspace, relative);
  normalizeRelative(workspace, source);
  let info;
  try { info = await lstat(source); } catch { manifest.absent.push(relative.replaceAll("\\", "/")); return; }
  if (!info.isFile()) return;
  manifest.files += 1;
  manifest.bytes += info.size;
  if (manifest.files > MAX_FILES || manifest.bytes > MAX_BYTES) throw new Error("Recovery checkpoint exceeds 100,000 files or 1 GiB; job refused");
  const normalized = relative.replaceAll("\\", "/");
  const destination = path.join(recoveryRoot, "files", ...normalized.split("/"));
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  if (!manifest.copied.includes(normalized)) manifest.copied.push(normalized);
}

export class RecoveryManager {
  constructor(private readonly recoveryBase: string) {}

  private root(jobId: string): string { return path.join(this.recoveryBase, jobId); }
  private manifestPath(jobId: string): string { return path.join(this.root(jobId), "manifest.json"); }

  async create(jobId: string, workspace: string): Promise<RecoveryManifest> {
    const root = this.root(jobId);
    await mkdir(root, { recursive: true });
    const git = await isGitRepository(workspace);
    const manifest: RecoveryManifest = { jobId, workspace: path.resolve(workspace), createdAt: new Date().toISOString(), git, copied: [], absent: [], bytes: 0, files: 0 };
    try {
      let candidates: string[] = [];
      if (git) {
        manifest.baselineHead = await gitHead(workspace);
        manifest.baselineStatus = await gitOutput(workspace, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
        candidates.push(...parseStatusPaths(manifest.baselineStatus));
        const ignored = await gitOutput(workspace, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]);
        candidates.push(...ignored.split("\0").filter(Boolean));
        if (manifest.baselineHead) {
          const bundle = path.join(root, "repository.bundle");
          await runFile("git", ["-C", workspace, "bundle", "create", bundle, "--all"], undefined, 120_000);
          const bundleSize = (await stat(bundle)).size;
          manifest.bytes += bundleSize;
          if (manifest.bytes > MAX_BYTES) throw new Error("Recovery checkpoint exceeds 1 GiB; job refused");
        }
      } else {
        candidates = await walk(workspace);
      }
      for (const relative of [...new Set(candidates)]) await copyCandidate(workspace, root, relative, manifest);
      await writeFile(this.manifestPath(jobId), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      return manifest;
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  async load(jobId: string): Promise<RecoveryManifest> {
    return JSON.parse(await readFile(this.manifestPath(jobId), "utf8")) as RecoveryManifest;
  }

  private extractPaths(call: ToolCall | ToolCallUpdate): string[] {
    const output = (call.locations ?? []).map((location) => location.path);
    const scan = (value: unknown, key = ""): void => {
      if (typeof value === "string" && /^(?:path|file|destination|source)$/i.test(key) && path.isAbsolute(value)) output.push(value);
      else if (Array.isArray(value)) value.forEach((entry) => scan(entry, key));
      else if (value && typeof value === "object") Object.entries(value).forEach(([child, entry]) => scan(entry, child));
    };
    scan(call.rawInput);
    return [...new Set(output)];
  }

  async backupBeforeWrite(jobId: string, call: ToolCall | ToolCallUpdate): Promise<void> {
    let manifest: RecoveryManifest;
    try { manifest = await this.load(jobId); } catch { return; }
    for (const target of this.extractPaths(call)) {
      const relative = normalizeRelative(manifest.workspace, target);
      if (relative === "." || manifest.copied.includes(relative) || manifest.absent.includes(relative)) continue;
      await copyCandidate(manifest.workspace, this.root(jobId), relative, manifest);
    }
    await writeFile(this.manifestPath(jobId), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  async restore(jobId: string, paths: string[], confirmation: string): Promise<string[]> {
    if (confirmation !== `RESTORE ${jobId}`) throw new Error(`Explicit confirmation required: RESTORE ${jobId}`);
    const manifest = await this.load(jobId);
    const restored: string[] = [];
    for (const requested of paths) {
      const target = path.resolve(manifest.workspace, requested);
      const relative = normalizeRelative(manifest.workspace, target);
      const stored = path.join(this.root(jobId), "files", ...relative.split("/"));
      if (manifest.copied.includes(relative)) {
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(stored, target);
      } else if (manifest.git && manifest.baselineHead) {
        const spec = `${manifest.baselineHead}:${relative.replaceAll("\\", "/")}`;
        try {
          const { stdout } = await runFile("git", ["-C", manifest.workspace, "show", spec], undefined, 60_000);
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, stdout, "utf8");
        } catch {
          throw new Error(`Path was not checkpointed: ${relative}`);
        }
      } else {
        throw new Error(`Path was not checkpointed: ${relative}`);
      }
      restored.push(relative);
    }
    return restored;
  }

  static fingerprint(value: string): string { return createHash("sha256").update(value).digest("hex"); }
}
