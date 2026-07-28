import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";

import { AcpRunner } from "./acp-runner.js";
import { changedFiles, gitDirty, gitHead, gitOutput, isGitRepository } from "./git.js";
import { LockManager, type HeldLocks } from "./locks.js";
import { redact, safeError } from "./redaction.js";
import { RecoveryManager } from "./recovery.js";
import { RecordStore } from "./storage.js";
import type { JobRecord, PreflightResult, StartJobInput } from "./types.js";

function transient(error: unknown): boolean {
  return /ECONNRESET|ETIMEDOUT|EPIPE|EOF|network|temporar|rate.?limit|process exited/i.test(error instanceof Error ? error.message : String(error));
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export class JobManager {
  readonly store: RecordStore;
  readonly recovery: RecoveryManager;
  readonly runner: AcpRunner;
  private readonly locks: LockManager;
  private readonly inputs = new Map<string, StartJobInput>();
  private readonly active = new Set<string>();
  private pumpTimer?: NodeJS.Timeout;

  constructor(store = new RecordStore()) {
    this.store = store;
    this.recovery = new RecoveryManager(store.recoveryDir);
    this.runner = new AcpRunner(this.recovery);
    this.locks = new LockManager(store.locksDir);
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.store.cleanup();
    for (const record of await this.store.list()) {
      if (["preparing", "running"].includes(record.status) && !processExists(record.ownerPid)) {
        record.status = "failed";
        record.error = "Host process stopped before job completed; recovery retained when available.";
        record.finishedAt = new Date().toISOString();
        record.updatedAt = record.finishedAt;
        record.recoveryAvailable = await this.store.recoveryExists(record.id);
        await this.store.save(record);
      }
    }
  }

  private async validateInput(input: StartJobInput): Promise<StartJobInput> {
    if (!path.isAbsolute(input.workspace)) throw new Error("workspace must be an absolute path");
    const workspace = path.resolve(input.workspace);
    if (!(await stat(workspace)).isDirectory()) throw new Error("workspace must be an existing directory");
    const additionalRoots: string[] = [];
    for (const root of input.additionalRoots ?? []) {
      if (!path.isAbsolute(root)) throw new Error("Every additional root must be absolute");
      const resolved = path.resolve(root);
      if (!(await stat(resolved)).isDirectory()) throw new Error(`Additional root does not exist: ${resolved}`);
      additionalRoots.push(resolved);
    }
    return { ...input, workspace, additionalRoots };
  }

  async preflight(workspace = process.cwd()): Promise<PreflightResult> {
    const resolved = path.resolve(workspace);
    if (!(await stat(resolved)).isDirectory()) throw new Error("Preflight workspace must be an existing directory");
    return this.runner.preflight(resolved);
  }

  async start(raw: StartJobInput): Promise<JobRecord> {
    const input = await this.validateInput(raw);
    const id = randomUUID();
    const now = new Date().toISOString();
    const record: JobRecord = {
      id,
      ownerPid: process.pid,
      status: "queued",
      jobType: input.jobType,
      workspace: input.workspace,
      additionalRoots: input.additionalRoots ?? [],
      taskSummary: redact(input.task).slice(0, 1000),
      policyMode: input.policyMode,
      allowDirty: Boolean(input.allowDirty),
      allowCommit: Boolean(input.allowCommit),
      model: input.model,
      thinking: input.thinking,
      timeoutSeconds: input.timeoutSeconds,
      createdAt: now,
      updatedAt: now,
      retries: 0,
      blockedActions: [],
      changedFiles: [],
      recoveryAvailable: false,
      acceptedRisk: "allow-unless-blocked"
    };
    this.inputs.set(id, input);
    await this.store.save(record);
    this.schedulePump(0);
    return record;
  }

  private schedulePump(delay = 250): void {
    if (this.pumpTimer) return;
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = undefined;
      void this.pump();
    }, delay);
    this.pumpTimer.unref();
  }

  private async pump(): Promise<void> {
    let started = false;
    for (const [jobId, input] of this.inputs) {
      if (this.active.size >= 2) break;
      const record = await this.store.get(jobId);
      if (!record || record.status !== "queued") continue;
      const held = await this.locks.acquire(jobId, input.workspace, input.jobType === "execute");
      if (!held) continue;
      started = true;
      this.active.add(jobId);
      void this.runOne(jobId, input, held);
    }
    if (this.inputs.size > this.active.size && !started) this.schedulePump(750);
  }

  private async update(jobId: string, changes: Partial<JobRecord>): Promise<JobRecord> {
    const record = await this.store.get(jobId);
    if (!record) throw new Error(`Unknown job: ${jobId}`);
    Object.assign(record, changes, { updatedAt: new Date().toISOString() });
    await this.store.save(record);
    return record;
  }

  private async runOne(jobId: string, input: StartJobInput, held: HeldLocks): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    let baselineStatus = "";
    try {
      await this.update(jobId, { status: "preparing", startedAt: new Date().toISOString(), progress: "Preparing workspace" });
      const git = await isGitRepository(input.workspace);
      const baselineCommit = git ? await gitHead(input.workspace) : undefined;
      if (git) baselineStatus = await gitOutput(input.workspace, ["status", "--porcelain=v1", "--untracked-files=all"]);
      await this.update(jobId, { baselineCommit });
      if (input.jobType === "execute" && git && await gitDirty(input.workspace) && !input.allowDirty) {
        await this.update(jobId, { status: "blocked", error: "Execute job refused: Git working tree is dirty. Explicit dirty override required.", finishedAt: new Date().toISOString() });
        return;
      }
      if (input.jobType === "execute") {
        await this.recovery.create(jobId, input.workspace);
        await this.update(jobId, { recoveryAvailable: true, progress: "Recovery checkpoint ready" });
      }
      await this.update(jobId, { status: "running", progress: "Kimi ACP session starting" });
      if (input.timeoutSeconds) {
        timer = setTimeout(() => { void this.runner.cancel(jobId); }, input.timeoutSeconds * 1000);
        timer.unref();
      }
      let result;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          result = await this.runner.run(jobId, input, {
            onSession: async (sessionId) => { await this.update(jobId, { sessionId }); },
            onProgress: async (progress) => { await this.update(jobId, { progress }); }
          });
          break;
        } catch (error) {
          if (attempt === 0 && transient(error)) {
            await this.update(jobId, { retries: 1, progress: "Transient ACP failure; retrying once" });
            continue;
          }
          throw error;
        }
      }
      if (!result) throw new Error("ACP job ended without a result");
      const diff = await changedFiles(input.workspace, baselineCommit);
      const currentStatus = git ? await gitOutput(input.workspace, ["status", "--porcelain=v1", "--untracked-files=all"]) : "";
      const readOnlyViolation = input.jobType !== "execute" && git && currentStatus !== baselineStatus;
      const latest = await this.store.get(jobId);
      const cancelled = latest?.status === "cancelled" || result.stopReason === "cancelled";
      await this.update(jobId, {
        status: cancelled ? "cancelled" : readOnlyViolation ? "failed" : "completed",
        stopReason: result.stopReason,
        finalMessage: result.finalMessage,
        usage: result.usage,
        blockedActions: result.blockedActions,
        changedFiles: diff.files,
        diffSummary: readOnlyViolation ? `READ-ONLY VIOLATION: ${diff.summary}` : diff.summary,
        resultingCommit: diff.head,
        error: readOnlyViolation ? "Analyze/plan job changed workspace despite read-only policy." : undefined,
        finishedAt: new Date().toISOString(),
        progress: cancelled ? "Cancelled" : "Finished"
      });
    } catch (error) {
      const latest = await this.store.get(jobId);
      await this.update(jobId, {
        status: latest?.status === "cancelled" ? "cancelled" : /checkpoint exceeds/i.test(safeError(error)) ? "blocked" : "failed",
        error: safeError(error),
        finishedAt: new Date().toISOString(),
        recoveryAvailable: await this.store.recoveryExists(jobId)
      });
    } finally {
      if (timer) clearTimeout(timer);
      this.active.delete(jobId);
      this.inputs.delete(jobId);
      await this.locks.release(held);
      this.schedulePump(0);
    }
  }

  async get(jobId: string): Promise<JobRecord> {
    const record = await this.store.get(jobId);
    if (!record) throw new Error(`Unknown job: ${jobId}`);
    return record;
  }

  async list(limit = 20): Promise<JobRecord[]> { return (await this.store.list()).slice(0, limit); }

  async cancel(jobId: string): Promise<JobRecord> {
    const record = await this.get(jobId);
    if (["completed", "failed", "blocked", "cancelled"].includes(record.status)) return record;
    await this.update(jobId, { status: "cancelled", progress: "Cancellation requested", finishedAt: new Date().toISOString() });
    if (record.status === "queued") this.inputs.delete(jobId);
    else await this.runner.cancel(jobId);
    return this.get(jobId);
  }

  async restore(jobId: string, paths: string[], confirmation: string): Promise<string[]> {
    const record = await this.get(jobId);
    if (!record.recoveryAvailable) throw new Error("No recovery checkpoint available for this job");
    return this.recovery.restore(jobId, paths, confirmation);
  }

  async shutdown(): Promise<void> { await this.runner.cancelAll(); }
}
