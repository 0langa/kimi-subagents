import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runFile } from "./process.js";
import type { JobType } from "./types.js";

export interface GuardEvent {
  at: string;
  decision: "allow" | "deny";
  rule: string;
  command: string;
}

export interface PreparedGuard {
  env: Record<string, string>;
  read(): Promise<GuardEvent[]>;
  dispose(): Promise<void>;
}

export interface GuardConfig {
  jobId: string;
  jobType: JobType;
  roots: string[];
  readOnlyRoots: string[];
  allowInterpreters: string[];
  allowCommit: boolean;
  allowDelete: boolean;
}

const WINDOWS_BASH_CANDIDATES = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  "C:\\Program Files\\Git\\usr\\bin\\bash.exe"
];
const POSIX_BASH_CANDIDATES = ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash"];

function posixRoot(value: string): string {
  const normalized = value.replaceAll("\\", "/").toLowerCase();
  const drive = /^([a-z]):\/(.*)$/.exec(normalized);
  return drive ? `/${drive[1]}/${drive[2]}` : normalized;
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function guardRoots(roots: string[]): string[] {
  return [...new Set(roots.flatMap((root) => {
    const resolved = path.resolve(root);
    return [posixRoot(resolved), resolved.replaceAll("\\", "/").toLowerCase()];
  }))];
}

export function guardAssetPath(): string {
  return fileURLToPath(new URL("../assets/shell-guard.sh", import.meta.url));
}

export function renderBootstrap(config: GuardConfig, guardPath: string, logPath: string): string {
  return [
    `# kimi-subagents guard bootstrap (job ${config.jobId})`,
    `KIMI_GUARD_ROOTS=(${guardRoots(config.roots).map(shellSingleQuote).join(" ")})`,
    `KIMI_GUARD_READ_ROOTS=(${guardRoots(config.readOnlyRoots).map(shellSingleQuote).join(" ")})`,
    `KIMI_GUARD_ALLOW_INTERPRETERS=${shellSingleQuote(config.allowInterpreters.map((entry) => entry.trim().toLowerCase()).join(" "))}`,
    `KIMI_GUARD_JOB_TYPE=${shellSingleQuote(config.jobType)}`,
    `KIMI_GUARD_ALLOW_COMMIT='${config.allowCommit ? 1 : 0}'`,
    `KIMI_GUARD_ALLOW_DELETE='${config.allowDelete ? 1 : 0}'`,
    `KIMI_GUARD_LOG=${shellSingleQuote(logPath.replaceAll("\\", "/"))}`,
    `. ${shellSingleQuote(guardPath.replaceAll("\\", "/"))}`,
    ""
  ].join("\n");
}

export async function locateBash(): Promise<string | undefined> {
  const explicit = process.env.KIMI_SUBAGENTS_BASH?.trim();
  const candidates = [
    ...(explicit ? [explicit] : []),
    ...(process.platform === "win32" ? WINDOWS_BASH_CANDIDATES : POSIX_BASH_CANDIDATES)
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch { /* try next candidate */ }
  }
  try {
    const { stdout } = await runFile(process.platform === "win32" ? "where" : "which", ["bash"], undefined, 10_000);
    const first = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0];
    return first;
  } catch {
    return undefined;
  }
}

export function parseGuardLog(raw: string, limit = 500): GuardEvent[] {
  const events = raw.split(/\r?\n/).filter(Boolean).flatMap<GuardEvent>((line) => {
    const [at, decision, rule, ...rest] = line.split("\t");
    if (!at || (decision !== "allow" && decision !== "deny")) return [];
    return [{ at, decision, rule: rule ?? "unknown", command: rest.join("\t").replaceAll("\\n", "\n") }];
  });
  return events.length > limit ? events.slice(-limit) : events;
}

export class ShellGuard {
  constructor(private readonly base: string, private readonly assetPath = guardAssetPath()) {}

  async prepare(config: GuardConfig): Promise<PreparedGuard> {
    if (!/^[a-z0-9-]+$/i.test(config.jobId)) throw new Error("Invalid shell guard job ID");
    const bash = await locateBash();
    if (!bash) throw new Error("Bash was not found; delegated jobs are refused because the shell guard cannot be installed");
    await access(this.assetPath, constants.R_OK).catch(() => {
      throw new Error(`Shell guard asset is missing at ${this.assetPath}; installation is incomplete`);
    });
    const directory = path.join(this.base, config.jobId);
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    const bootstrapPath = path.join(directory, "bootstrap.sh");
    const guardPath = path.join(directory, "shell-guard.sh");
    const logPath = path.join(directory, "guard.log");
    // Copy with normalized line endings: a CRLF checkout of the asset would make
    // Git Bash fail on every guarded command.
    await writeFile(guardPath, (await readFile(this.assetPath, "utf8")).replaceAll("\r\n", "\n"), { encoding: "utf8", mode: 0o600 });
    await writeFile(bootstrapPath, renderBootstrap(config, guardPath, logPath), { encoding: "utf8", mode: 0o600 });
    await writeFile(logPath, "", { encoding: "utf8", mode: 0o600 });
    try {
      await runFile(bash, ["-n", bootstrapPath.replaceAll("\\", "/")], undefined, 15_000);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw new Error(`Shell guard failed validation and the job was refused: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    return {
      env: {
        BASH_ENV: bootstrapPath.replaceAll("\\", "/"),
        KIMI_SHELL_PATH: bash,
        KIMI_GUARD_LOG: logPath.replaceAll("\\", "/")
      },
      read: async () => parseGuardLog(await readFile(logPath, "utf8").catch(() => "")),
      dispose: async () => { await rm(directory, { recursive: true, force: true }); }
    };
  }
}
