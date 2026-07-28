import { link, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runFile } from "./process.js";

function defaultKimiHome(): string {
  return path.resolve(process.env.KIMI_CODE_HOME ?? path.join(os.homedir(), ".kimi-code"));
}

async function exists(candidate: string): Promise<boolean> {
  try { await stat(candidate); return true; } catch { return false; }
}

function safeConfig(raw: string): string {
  const lines = raw.split(/\r?\n/);
  const root = lines.find((line) => /^\s*default_model\s*=/.test(line));
  const blocks: Array<{ name: string; lines: string[] }> = [];
  let current: { name: string; lines: string[] } | undefined;
  for (const line of lines) {
    const section = line.match(/^\s*\[(.+)]\s*$/);
    if (section) {
      current = { name: section[1]!, lines: [line] };
      blocks.push(current);
    } else if (current) current.lines.push(line);
  }
  const managed = blocks.find((block) => block.name === 'providers."managed:kimi-code"');
  const oauth = blocks.find((block) => block.name === 'providers."managed:kimi-code".oauth');
  const models = blocks.filter((block) => block.name.startsWith('models.') && block.lines.some((line) => /^\s*provider\s*=\s*"managed:kimi-code"\s*$/.test(line)));
  if (!root || !managed || !oauth || models.length === 0) throw new Error("Managed Kimi OAuth configuration unavailable for isolated ACP runtime");
  const apiKey = managed.lines.find((line) => /^\s*api_key\s*=/.test(line));
  if (apiKey && !/^\s*api_key\s*=\s*""\s*$/.test(apiKey)) {
    throw new Error("Non-empty config API keys are not copied into isolated ACP runtime; use Kimi managed OAuth");
  }
  const allowed = (block: { name: string; lines: string[] }, keys: string[]) => [
    block.lines[0]!,
    ...block.lines.slice(1).filter((line) => keys.some((key) => new RegExp(`^\\s*${key}\\s*=`).test(line)))
  ].join("\n");
  const output = [
    root,
    "merge_all_available_skills = false",
    "extra_skill_dirs = []",
    allowed(managed, ["type", "api_key", "base_url"]),
    allowed(oauth, ["storage", "key"]),
    ...models.map((block) => allowed(block, ["provider", "model", "max_context_size", "max_input_size", "capabilities", "display_name", "support_efforts", "default_effort"]))
  ];
  return `${output.join("\n\n")}\n`;
}

async function gitSetting(name: string): Promise<string | undefined> {
  try {
    const value = (await runFile("git", ["config", "--global", "--get", name], undefined, 10_000)).stdout.trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

// The delegated process gets a relocated HOME/USERPROFILE so that host skill
// directories (~/.agents/skills and friends) and credential files such as
// ~/.npmrc or ~/.ssh are invisible to it. Git identity is the one host setting
// worth carrying over, so local commits keep the user's authorship.
export async function gitIdentity(): Promise<string> {
  const name = await gitSetting("user.name");
  const email = await gitSetting("user.email");
  return `[user]\n${name ? `\tname = ${name}\n` : ""}${email ? `\temail = ${email}\n` : ""}`;
}

export class IsolatedKimiHome {
  constructor(
    private readonly base: string,
    private readonly source = defaultKimiHome()
  ) {}

  async prepare(id: string): Promise<string> {
    if (!/^[a-z0-9-]+$/i.test(id)) throw new Error("Invalid isolated Kimi home ID");
    const target = path.join(this.base, id);
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    try {
      const credentials = path.join(this.source, "credentials");
      if (!(await exists(credentials))) throw new Error("Kimi credentials directory unavailable for isolated ACP runtime");
      await symlink(credentials, path.join(target, "credentials"), process.platform === "win32" ? "junction" : "dir");
      const device = path.join(this.source, "device_id");
      if (await exists(device)) await link(device, path.join(target, "device_id"));
      const config = safeConfig(await readFile(path.join(this.source, "config.toml"), "utf8"));
      await writeFile(path.join(target, "config.toml"), config, { encoding: "utf8", mode: 0o600 });
      await writeFile(path.join(target, ".gitconfig"), await gitIdentity(), { encoding: "utf8", mode: 0o600 });
      return target;
    } catch (error) {
      await rm(target, { recursive: true, force: true });
      throw error;
    }
  }

  async dispose(id: string): Promise<void> {
    const target = path.resolve(this.base, id);
    const base = path.resolve(this.base);
    if (path.dirname(target) !== base) throw new Error("Refusing to remove unexpected isolated Kimi home");
    await rm(target, { recursive: true, force: true });
  }
}
