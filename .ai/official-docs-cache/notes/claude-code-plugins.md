---
provider: claude-code
topic: plugins
checked_at: 2026-07-28
stability: likely-changing
refresh_after_days: 7
sources:
  - url: https://code.claude.com/docs/en/plugins-reference
    title: Claude Code Plugins Reference
claims:
  - Plugin root uses .claude-plugin/plugin.json; skills and commands stay at root; MCP servers use .mcp.json.
  - Marketplace plugins install into cache and user scope is available across projects.
  - Plugin skills and commands are namespaced by plugin name.
  - CLAUDE_PLUGIN_ROOT is available for bundled executable paths.
used_by:
  - kimi-subagents-v0.1
---

## Notes

Installed Claude Code 2.1.199 help verified marketplace add, plugin install with user scope, and strict plugin validation on 2026-07-28.

Claude Code plugin MCP paths must use `${CLAUDE_PLUGIN_ROOT}` in `command`, `args`, or `env`; host working directory is not plugin root. Verified against Claude Code 2.1.220 and official plugin/MCP references on 2026-07-28 after a relative `dist/server.mjs` launch failed outside the source repository.
