# Architecture

```text
Codex / Claude Code
  -> shared skill controls off/manual/ask/auto in host conversation
  -> local stdio MCP server (dist/server.mjs)
     -> JobManager: queue, two global slots, one writer/workspace
     -> RecordStore: atomic redacted records, seven-day retention
     -> RecoveryManager: checkpoint and selected restore
     -> AcpRunner: one `kimi acp` process/job
        -> isolated temporary KIMI_CODE_HOME; managed OAuth link; filtered model config
        <-> ACP initialize, session/new, config, prompt, updates, permissions, cancel
        -> Kimi tools inside granted roots
```

## State ownership

Delegation mode belongs to active host conversation. MCP server deliberately has no global `set_mode` tool, preventing one Codex/Claude task from changing another task's policy. Job records include supplied mode only as audit metadata.

Job lifecycle is `queued -> preparing -> running -> completed|failed|blocked|cancelled`. Cross-process lock files under runtime root cap total jobs at two. Execute writer lock is keyed by canonical workspace. One transient ACP failure retries once.

## ACP lifecycle

1. Build temporary Kimi home containing managed OAuth credential link and filtered provider/model config only. Refuse enabled project-local Kimi MCP configuration.
2. Spawn installed `kimi acp` without a shell and with isolated `KIMI_CODE_HOME`.
3. Initialize ACP v1 and create fresh session with no forwarded or inherited MCP servers.
4. Set native `mode=plan` for plan jobs; set model/thinking only when explicitly supplied.
5. Stream redacted progress and tool metadata into job record.
6. Broker each permission request.
7. Capture final message, stop reason, ACP usage when present, blocked actions, pre-existing dirty paths, job-attributed paths, and commit range.
8. Close stdin; force-terminate process tree if it does not exit. Remove isolated Kimi session/log state. Host shutdown cancels all active jobs.

`/goal` is absent. Kimi Code 0.29.2 ACP returned `Unknown ACP command: /goal` during live verification.

## Verification boundary

Kimi output is candidate work. Main Codex/Claude agent owns acceptance:

1. inspect diff or explicitly delegated local commit range;
2. rerun relevant tests/checks independently;
3. report accepted, repaired, or rejected;
4. perform any approved remote operation itself.
