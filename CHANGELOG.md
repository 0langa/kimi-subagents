# Changelog

## 0.3.2

Two guard defects found by re-running the 0.3.1 verification jobs. Both fixes
confirmed against the real guard log.

### Fixed

- **A read with a discarded redirect was denied as a write.** `ls -d "/c/Program Files/PowerShell/Modules"/* 2> /dev/null` was blocked as `write outside granted roots` because the write test matched the bare `>` in `2> /dev/null`. Redirections to `/dev/null` and `2>&1` are now stripped before the write test, so out-of-root reads keep working while real writes are still denied.
- **Delegated interpreter commands were logged twice**, inflating the command count. Each inspected command now produces exactly one log line, tagged `interpreter-delegated` when the job granted that interpreter.


## 0.3.1

Fixes found by the first real delegated runs on Claude Code and Codex. Both runs
completed their task; both hit policy defects that made the delegate far less
useful than it should be.

### Fixed

- **Plan jobs could not deliver a plan.** `ExitPlanMode` was refused as an unrecognised tool, so Kimi resubmitted it 28 times over 21 minutes before the host cancelled the job. Turn-control tools (`ExitPlanMode`, `EnterPlanMode`, `TodoWrite`) change nothing outside the session and are now allowed in every job type.
- **A refused tool could spin forever.** The stall detector only watches for silence, and Kimi was busy retrying. The broker now stops a job after the same tool is refused four times, reporting `Job stopped after a policy deadlock: ...`.
- **The workspace root could be refused as an escape.** Kimi truncates command previews at 50 characters, which cuts a long root mid-name; the fragment failed the prefix test and the job lost the shell entirely (zero commands executed in both observed runs). A candidate path that is a prefix of a granted root is now treated as truncation and deferred to the shell guard, which sees the full command.
- **`AskUserQuestion` is refused with its own rule** (`no-interactive-user`) instead of looking like an unknown tool; a delegated job has no user to ask.
- **The shell guard only checked the first absolute path in a command.** It now checks every one.
- **Follow-up jobs dropped capability flags.** `allowNetwork`, `allowSubagents`, `readOnlyRoots`, `allowInterpreters` and `trackUsage` are inherited from the parent job.
- **Usage Pulse hooks never fired.** `uv run` re-resolves the environment under the relocated HOME and overran the hook timeout; the hooks now use the plugin's own interpreter when it has one.

### Added

- `readOnlyRoots`: absolute paths a job may read but never write. Reads outside the workspace previously had no grant path at all.
- `allowInterpreters`: opt-in list (`pwsh`, `powershell`, `cmd`, `wsl`). Without it a delegated job on Windows can write PowerShell but never run it, which is how the first run shipped five failing tests.


## 0.3.0

Closes the three gaps 0.2.0 documented as open: self-approved Kimi tools, missing usage data, and an unclear sandbox stance.

### Added

- Delegate runtime: the environment of a delegated job now disables what Kimi approves for itself. `KIMI_SUBAGENT_TIMEOUT_MS=1` makes `Agent`/`AgentSwarm` fail instantly, `KIMI_DISABLE_CRON=1` disables cron, the isolated home carries no search credentials so `WebSearch` fails, background tasks are capped, telemetry and auto-update are off, and `KIMI_LOOP_MAX_STEPS_PER_TURN` bounds the loop.
- Runtime `AGENTS.md` written into the isolated home (`assets/delegate-agents.md`). It forbids the network, nested agents, cron and goals, and outranks any `AGENTS.md` inside the workspace — verified live against a workspace file that instructs the opposite.
- Tool-call watch: `FetchURL` and `WebSearch` cannot be removed from Kimi, so every self-approved tool call is inspected. An unauthorised network call is recorded as a `toolViolation` and cancels the job; subagent, cron and goal attempts are recorded.
- Job flags `allowNetwork`, `allowSubagents`, `maxSteps`, and `trackUsage`.
- Usage Pulse opt-in: with `trackUsage` (or `KIMI_SUBAGENTS_USAGE_PULSE=1`) the isolated home re-adds Usage Pulse's own hooks and `USAGE_PULSE_HOME` points at the real store, so delegated jobs appear in local usage counters.
- Live coverage for each of the above, plus a live usage-pulse suite.

### Changed

- The delegated system prompt states the network and subagent policy of the job instead of the old "at most two nested agents" line.
- SECURITY.md documents the three enforcement layers, records that Kimi's `[tools] disabled` config section does not apply to the ACP path, and states the no-sandbox posture as a deliberate product decision rather than an open gap.

### Known limits

- A cancelled network call may already have left the machine: this is detection plus termination, not egress prevention.
- Kimi's ACP `PromptResponse` still reports no token usage, so per-job cost comes from Usage Pulse or nowhere.

## 0.2.0

Delegation policy is now actually enforced. Live capture against Kimi Code 0.29.2 showed that an ACP permission request carries only the tool name and a description truncated at 50 characters — no `rawInput`, no `locations`, never the full shell command — so the previous policy allowed every shell command and denied every `Write`.

### Added

- Shell guard (`assets/shell-guard.sh`) sourced through `BASH_ENV` into every shell a job starts, including nested and subagent shells. A `DEBUG` trap inspects the complete command text and exits 126 on denial. The bootstrap is syntax-checked with `bash -n` before the job starts; jobs are refused when the guard cannot be installed.
- Full shell command log per job (`shellCommands`), with guard denials mirrored into `blockedActions` as `source: "shell-guard"`.
- `allowDelete` flag: file deletion is denied by default and opens only for the job that asks for it.
- `kimi_followup`: continue a finished job with a new instruction, inheriting workspace, roots and flags plus a compact parent summary.
- Deterministic per-job-type reasoning effort (`low` for analyze, `high` for plan and execute), overridable with `effort`.
- Stall watchdog: a job with no reported Kimi activity for `stallSeconds` (default 900) is cancelled and marked failed.
- Capped unified diff (`diffPatch`) of everything an execute job left behind, for main-agent review.
- Live test suite (`npm run test:live`) that drives the installed Kimi binary and asserts guard enforcement, skill isolation and MCP isolation.
- `.gitattributes` pinning shell assets to LF, plus runtime line-ending normalization, so a CRLF checkout cannot disable the guard.

### Changed

- The ACP broker parses the payload Kimi actually sends (`Running:`, `Writing`, `Editing`, `Call`, `diff` entries), resolves relative paths against the workspace, refuses MCP tool calls and denies anything it cannot parse.
- Permission approvals are one-shot; `allow_always` is never selected, so every call is re-evaluated.
- Isolation relocates `HOME` and `USERPROFILE` to the temporary Kimi home: host skill directories and host credential files are invisible to delegated jobs, and only Git identity is carried forward. A delegated session sees Kimi's built-in skills and nothing else.
- `kimi_result` returns the summary, changed files and denied commands by default; diff, full shell log and full Kimi message are opt-in through `include`.
- Package publication (`npm publish` and friends) and global tool configuration changes are denied.
- Recovery pre-write backups use the paths the permission payload actually carries.
- Deterministic tests are rebuilt from captured live payloads (`tests/fixtures/acp-permission-payloads.json`).

### Fixed

- Shell commands were never evaluated against the deny rules, so destructive Git, `git push`, and writes outside the granted roots executed unchecked.
- `Write` calls were rejected for lacking an absolute path Kimi never sends, which pushed file creation into the unguarded shell channel.
- Job records no longer throw when their storage disappears while a job is finishing.

## 0.1.1

Isolated Kimi ACP execution: temporary `KIMI_CODE_HOME`, filtered provider configuration, refusal of enabled project-local Kimi MCP servers.

## 0.1.0

First development build: asynchronous ACP jobs, session modes, checkpoints, recovery, redacted job records.
