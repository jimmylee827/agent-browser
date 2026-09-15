import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SECRET_KEYS = /(token|secret|password|cookie|authorization|refresh|access)/i;

/** Shallow redaction so credentials never reach the audit log. */
function redact(value: unknown): unknown {
  if (value == null || typeof value !== "object") return value;
  const out: Record<string, unknown> = Array.isArray(value) ? ([] as never) : {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEYS.test(k) ? "[redacted]" : redact(v);
  }
  return out;
}

export class Audit {
  constructor(private file: string) {
    mkdirSync(dirname(file), { recursive: true });
  }
  log(event: string, data: Record<string, unknown> = {}): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...(redact(data) as object) });
    appendFileSync(this.file, line + "\n");
  }
}
