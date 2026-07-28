import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import process from "node:process";

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
const checks = [
  { name: "GitHub token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { name: "OpenAI-style key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "personal absolute path", pattern: /C:\\Users\\Julius/i },
  { name: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ }
];
const allow = new Set(["scripts/security-scan.mjs"]);
const findings = [];
for (const file of files) {
  if (!existsSync(file) || allow.has(file) || /\.(?:png|jpg|jpeg|gif|ico|map)$/i.test(file)) continue;
  const text = readFileSync(file, "utf8");
  for (const check of checks) if (check.pattern.test(text)) findings.push(`${file}: ${check.name}`);
}
if (findings.length > 0) {
  process.stderr.write(`${findings.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Security scan passed (${files.length} tracked files).\n`);
}
