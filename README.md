# kimi-subagents

Cross-client plugin for delegating suitable Codex and Claude Code tasks to Kimi Code agents when explicitly requested by the user.

## Status

Early design phase. Plugin behavior, safety boundaries, and provider integrations are not implemented yet.

## Goals

- Let Codex and Claude Code deploy and orchestrate Kimi Code agents during active work.
- Require explicit user direction before delegating work to Kimi Code.
- Reduce use of higher-cost models for tasks that need less reasoning capacity.
- Support distribution through the personal `0langas-plugins` marketplace.

## License

MIT
