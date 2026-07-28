import { createHash } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";

interface LockPayload { pid: number; jobId: string; createdAt: string }
export interface HeldLocks { slot: string; writer?: string }

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export class LockManager {
  constructor(private readonly directory: string) {}

  private async tryCreate(target: string, payload: LockPayload): Promise<boolean> {
    await mkdir(this.directory, { recursive: true });
    try {
      const handle = await open(target, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(payload)}\n`, "utf8");
      await handle.close();
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const existing = JSON.parse(await readFile(target, "utf8")) as LockPayload;
        if (processExists(existing.pid)) return false;
      } catch { /* malformed lock is stale */ }
      await rm(target, { force: true });
      try {
        const handle = await open(target, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify(payload)}\n`, "utf8");
        await handle.close();
        return true;
      } catch { return false; }
    }
  }

  async acquire(jobId: string, workspace: string, writer: boolean): Promise<HeldLocks | undefined> {
    const payload = { pid: process.pid, jobId, createdAt: new Date().toISOString() };
    let writerPath: string | undefined;
    if (writer) {
      const digest = createHash("sha256").update(path.resolve(workspace).toLowerCase()).digest("hex");
      writerPath = path.join(this.directory, `writer-${digest}.lock`);
      if (!(await this.tryCreate(writerPath, payload))) return undefined;
    }
    for (let index = 0; index < 2; index += 1) {
      const slot = path.join(this.directory, `slot-${index}.lock`);
      if (await this.tryCreate(slot, payload)) return { slot, writer: writerPath };
    }
    if (writerPath) await rm(writerPath, { force: true });
    return undefined;
  }

  async release(held: HeldLocks): Promise<void> {
    await Promise.all([rm(held.slot, { force: true }), ...(held.writer ? [rm(held.writer, { force: true })] : [])]);
  }
}
