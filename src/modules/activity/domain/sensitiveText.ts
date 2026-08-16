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

export function redactSensitiveText(value: string): string {
  return credentialPatterns.reduce(
    (redacted, [pattern, replacement]) => redacted.replace(pattern, replacement),
    value
  );
}
