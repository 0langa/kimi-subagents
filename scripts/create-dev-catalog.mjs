import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const sha = (process.argv[2] ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" })).trim();
if (!/^[a-f0-9]{40}$/i.test(sha)) throw new Error("Expected exact 40-character Git SHA");
const originMain = execFileSync("git", ["rev-parse", "origin/main"], { encoding: "utf8" }).trim();
execFileSync("git", ["merge-base", "--is-ancestor", sha, originMain]);

const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
const root = path.join(local, "kimi-subagents", "dev-marketplace");
const source = { source: "url", url: "https://github.com/0langa/kimi-subagents.git", ref: sha, sha };
const codex = {
  name: "kimi-subagents-dev",
  interface: { displayName: "Kimi Subagents Dev" },
  plugins: [{
    name: "kimi-subagents",
    source,
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: "Developer Tools"
  }]
};
const claude = {
  name: "kimi-subagents-dev",
  description: "Pinned development catalog for Kimi Subagents.",
  owner: { name: "0langa" },
  plugins: [{
    name: "kimi-subagents",
    source,
    displayName: "Kimi Subagents",
    description: "Guarded Kimi Code ACP delegation for Codex and Claude Code.",
    version: "0.1.1",
    repository: "https://github.com/0langa/kimi-subagents"
  }]
};
mkdirSync(path.join(root, ".agents", "plugins"), { recursive: true });
mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
writeFileSync(path.join(root, ".agents", "plugins", "marketplace.json"), `${JSON.stringify(codex, null, 2)}\n`);
writeFileSync(path.join(root, ".claude-plugin", "marketplace.json"), `${JSON.stringify(claude, null, 2)}\n`);
writeFileSync(path.join(root, "PINNED_SHA"), `${sha}\n`);
process.stdout.write(`${JSON.stringify({ marketplace: root, sha }, null, 2)}\n`);
