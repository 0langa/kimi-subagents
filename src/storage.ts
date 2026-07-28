import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { redactJson } from "./redaction.js";
import type { JobRecord } from "./types.js";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function runtimeRoot(): string {
  if (process.env.KIMI_SUBAGENTS_HOME) return path.resolve(process.env.KIMI_SUBAGENTS_HOME);
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  return path.join(local, "kimi-subagents");
}

export class RecordStore {
  readonly root: string;
  readonly jobsDir: string;
  readonly recoveryDir: string;
  readonly locksDir: string;
  private readonly writes = new Map<string, Promise<void>>();

  constructor(root = runtimeRoot()) {
    this.root = root;
    this.jobsDir = path.join(root, "jobs");
    this.recoveryDir = path.join(root, "recovery");
    this.locksDir = path.join(root, "locks");
  }

  async initialize(): Promise<void> {
    await Promise.all([this.jobsDir, this.recoveryDir, this.locksDir].map((dir) => mkdir(dir, { recursive: true })));
  }

  private recordPath(id: string): string {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error("Invalid job ID");
    return path.join(this.jobsDir, `${id}.json`);
  }

  private async saveNow(record: JobRecord): Promise<void> {
    await this.initialize();
    const target = this.recordPath(record.id);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    const backup = `${target}.bak`;
    await writeFile(temporary, `${JSON.stringify(redactJson(record), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rm(backup, { force: true });
    try { await rename(target, backup); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try {
      await rename(temporary, target);
      await rm(backup, { force: true });
    } catch (error) {
      try { await rename(backup, target); } catch { /* retain original failure */ }
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async save(record: JobRecord): Promise<void> {
    const prior = this.writes.get(record.id) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(() => this.saveNow(record));
    this.writes.set(record.id, next);
    try { await next; } finally { if (this.writes.get(record.id) === next) this.writes.delete(record.id); }
  }

  async get(id: string): Promise<JobRecord | undefined> {
    const target = this.recordPath(id);
    try {
      return JSON.parse(await readFile(target, "utf8")) as JobRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        try { return JSON.parse(await readFile(`${target}.bak`, "utf8")) as JobRecord; } catch (backupError) {
          if ((backupError as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw backupError;
        }
      }
      throw error;
    }
  }

  async list(): Promise<JobRecord[]> {
    await this.initialize();
    const names = (await readdir(this.jobsDir)).filter((name) => name.endsWith(".json"));
    const records = await Promise.all(names.map((name) => this.get(name.slice(0, -5))));
    return records.filter((record): record is JobRecord => Boolean(record)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async cleanup(now = Date.now()): Promise<number> {
    await this.initialize();
    let removed = 0;
    for (const record of await this.list()) {
      if (now - Date.parse(record.updatedAt) <= RETENTION_MS) continue;
      await rm(this.recordPath(record.id), { force: true });
      await rm(path.join(this.recoveryDir, record.id), { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  }

  async recoveryExists(id: string): Promise<boolean> {
    try {
      return (await stat(path.join(this.recoveryDir, id, "manifest.json"))).isFile();
    } catch {
      return false;
    }
  }
}
