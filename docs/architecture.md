# Architecture

```text
Codex / Claude Code
  -> shared skill controls off/manual/ask/auto in host conversation
  -> local stdio MCP server (dist/server.mjs)
     -> JobManager: queue, two global slots, one writer/workspace
     -> RecordStore: atomic redacted records, seven-day retention
     -> RecoveryManager: checkpoint and selected restore
     -> ShellGuard: per-job bootstrap + assets/shell-guard.sh, validated with `bash -n`
     -> AcpRunner: one `kimi acp` process/job
        -> isolated temporary KIMI_CODE_HOME, relocated HOME/USERPROFILE, managed OAuth link
        -> BASH_ENV shell guard active in every Kimi shell, including nested and subagent shells
        <-> ACP initialize, session/new, config, prompt, updates, permissions, cancel
        -> Kimi tools inside granted roots
```

## State ownership

Delegation mode belongs to the active host conversation. The MCP server deliberately has no global `set_mode` tool, so one Codex or Claude task cannot change another task's policy. Job records carry the supplied mode as audit metadata only.

Job lifecycle is `queued -> preparing -> running -> completed|failed|blocked|cancelled`. Cross-process lock files under the runtime root cap total jobs at two. The execute writer lock is keyed by canonical workspace. One transient ACP failure retries once.

## Enforcement

Three layers, because none is sufficient alone.

0. **Delegate runtime.** Before the session starts, the job's environment turns off what Kimi would otherwise approve for itself: `KIMI_SUBAGENT_TIMEOUT_MS=1` (nested agents fail instantly unless `allowSubagents`), `KIMI_DISABLE_CRON=1`, no search credentials in the isolated home, bounded background tasks, telemetry and auto-update off, and a hard `KIMI_LOOP_MAX_STEPS_PER_TURN`. The runtime also writes its own `AGENTS.md` into the isolated home, which outranks workspace instruction files. `FetchURL` survives all of that (its fetcher falls back to a local request), so the tool-call stream is watched and an unauthorised network call cancels the job and is recorded as a `toolViolation`.

1. **ACP permission broker.** Kimi's `session/request_permission` carries only `toolCallId`, `title` and `content[]` — no `rawInput`, no `locations` — and truncates command previews at 50 characters. `src/policy.ts` parses what is there (`Running:`, `Writing`, `Editing`, `Call`, `diff` entries), resolves relative paths against the workspace, and denies anything it cannot parse.
2. **Shell guard.** `assets/shell-guard.sh` is sourced through `BASH_ENV` in every Bash process the job starts. A `DEBUG` trap sees the complete command text, applies the deny rules, exits 126 on denial, and appends every decision to a per-job log. Depth is tracked through an exported counter so nested build scripts are not held to the rules that apply to Kimi's own commands.

The guard log becomes `JobRecord.shellCommands`; guard denials also become `blockedActions` entries with `source: "shell-guard"`.

## ACP lifecycle

1. Prepare the shell guard bootstrap and validate it (`bash -n`). Refuse the job when bash or the guard asset is unavailable.
2. Build a temporary Kimi home containing the managed OAuth credential link, filtered provider/model config, a minimal `.gitconfig`, the runtime `AGENTS.md`, and — only when `trackUsage` is set — Usage Pulse's own hook entries. Refuse enabled project-local Kimi MCP configuration.
3. Spawn the installed `kimi acp` without a shell, with `KIMI_CODE_HOME`, `HOME` and `USERPROFILE` pointing at that temporary home, the delegate-runtime environment applied, `BASH_ENV` at the guard bootstrap and `KIMI_SHELL_PATH` at the resolved bash.
4. Initialize ACP v1 and create a fresh session with no forwarded or inherited MCP servers.
5. Set native `mode=plan` for plan jobs; set model and thinking only when explicitly supplied.
6. Stream redacted progress and tool metadata into the job record.
7. Broker each permission request one-shot; `allow_always` is never selected.
8. Capture the final message, stop reason, ACP usage when present, blocked actions, shell command log, pre-existing dirty paths, job-attributed paths and commit range.
9. Close stdin, force-terminate the process tree if it does not exit, remove isolated Kimi state and the guard directory. Host shutdown cancels all active jobs.

`/goal` is absent: Kimi Code 0.29.2 ACP returned `Unknown ACP command: /goal` during live verification.

## Determinism

The delegated environment is fixed rather than inherited: no host skills, no host MCP servers, no host hooks, no host credential files, a resolved bash path and a one-shot approval policy. The same job definition therefore behaves the same from Claude Code and from Codex, CLI or desktop, on any machine with the same Kimi version.

## Verification boundary

Kimi output is candidate work. The main Codex or Claude agent owns acceptance:

1. inspect the diff or the explicitly delegated local commit range;
2. rerun the relevant tests and checks independently;
3. report accepted, repaired or rejected;
4. perform any approved remote operation itself.

## Test layers

- `npm test` — deterministic suite, no Kimi process, ACP fixtures shaped from captured live payloads (`tests/fixtures/acp-permission-payloads.json`).
- `npm run test:live` — drives the installed Kimi binary through real jobs and asserts guard enforcement, skill isolation and MCP isolation.
