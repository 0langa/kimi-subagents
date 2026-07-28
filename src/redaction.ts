const TOKEN_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
  /\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g,
  /("?(?:token|api[_-]?key|secret|password|credential)"?\s*[:=]\s*["']?)[^\s,"'}]+/gi
];

function knownSecretValues(): string[] {
  return Object.entries(process.env)
    .filter(([name, value]) => /TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL/i.test(name) && Boolean(value) && value!.length >= 8)
    .map(([, value]) => value!);
}

export function redact(value: string): string {
  let output = value;
  for (const secret of knownSecretValues()) output = output.split(secret).join("[REDACTED]");
  for (const pattern of TOKEN_PATTERNS) output = output.replace(pattern, (_match, prefix?: string) => `${prefix ?? ""}[REDACTED]`);
  return output;
}

export function safeError(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error));
}

export function redactJson<T>(value: T): T {
  return JSON.parse(redact(JSON.stringify(value))) as T;
}
