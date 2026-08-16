const credentialPatterns: readonly [RegExp, string][] = [
  [/\bsk-[A-Za-z0-9_-]{10,}\b/g, "[REDACTED]"],
  [/\bgh[pousr]_[A-Za-z0-9]{10,}\b/g, "[REDACTED]"],
  [/\bglpat-[A-Za-z0-9_-]{10,}\b/g, "[REDACTED]"],
  [/\bnpm_[A-Za-z0-9]{10,}\b/g, "[REDACTED]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"],
  [/\b(Bearer)\s+[^\s,;]+/gi, "$1 [REDACTED]"],
  [/(\b(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[REDACTED]"],
  [/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]"]
];

const sensitiveKey = /(?:authorization|cookie|credential|password|secret|token|api[_-]?key)/i;
const maxStringCharacters = 32_000;
const maxCollectionItems = 100;
const maxDepth = 6;
const truncationMarker = "\n[… truncated …]";

export function redactSensitiveText(value: string): string {
  return credentialPatterns.reduce(
    (redacted, [pattern, replacement]) => redacted.replace(pattern, replacement),
    value
  );
}

export function redactAndTruncateSensitiveText(value: string, maxCharacters = maxStringCharacters): string {
  const redacted = redactSensitiveText(value);
  if (redacted.length <= maxCharacters) return redacted;
  if (maxCharacters <= truncationMarker.length) return truncationMarker.slice(0, Math.max(0, maxCharacters));
  return `${redacted.slice(0, maxCharacters - truncationMarker.length)}${truncationMarker}`;
}

export function redactSensitiveData(value: unknown): unknown {
  return sanitize(value, 0, new WeakSet<object>());
}

function sanitize(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactAndTruncateSensitiveText(value);
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value !== "object") return redactAndTruncateSensitiveText(String(value));
  if (depth >= maxDepth) return "[TRUNCATED]";
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, maxCollectionItems).map(item => sanitize(item, depth + 1, seen));
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, maxCollectionItems)) {
    output[key] = sensitiveKey.test(key) ? "[REDACTED]" : sanitize(item, depth + 1, seen);
  }
  return output;
}
