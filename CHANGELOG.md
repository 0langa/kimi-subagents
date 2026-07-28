# Changelog

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
