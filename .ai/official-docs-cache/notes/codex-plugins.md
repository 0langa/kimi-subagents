---
provider: openai
topic: codex-plugins
checked_at: 2026-07-28
stability: likely-changing
refresh_after_days: 7
sources:
  - url: https://developers.openai.com/codex/plugins
    title: Codex Plugins
claims:
  - Codex plugins can bundle skills and MCP server configuration behind a plugin manifest.
  - Codex marketplace sources can be local directories or Git repositories.
  - Installed plugins are selected by plugin-name at marketplace-name.
used_by:
  - kimi-subagents-v0.1
---

## Notes

Installed Codex 0.144.1 help verified `codex plugin marketplace add <SOURCE>` and `codex plugin add <PLUGIN@MARKETPLACE>` on 2026-07-28.
