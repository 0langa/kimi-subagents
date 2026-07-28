import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function runFile(command: string, args: string[], cwd?: string, timeout = 30_000): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(command, args, {
    cwd,
    timeout,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    encoding: "utf8"
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

export async function terminateProcessTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.once("error", () => resolve());
      killer.once("exit", () => resolve());
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try { process.kill(pid, "SIGKILL"); } catch { /* already stopped */ }
  }
}

export function sanitizedChildEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  for (const name of Object.keys(env)) {
    if (/^(?:GITHUB_TOKEN(?:_ELEVATED|_FULL)?|GH_TOKEN|GITLAB_TOKEN|NPM_TOKEN)$/i.test(name)) delete env[name];
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY = "2";
  return env;
}
