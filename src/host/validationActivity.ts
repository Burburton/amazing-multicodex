import { ValidationRun } from "../modules/validation/public";

const DEFAULT_OUTPUT_CHARACTERS = 4_000;

export function formatValidationActivity(
  run: ValidationRun,
  labels: readonly string[],
  maxOutputCharacters = DEFAULT_OUTPUT_CHARACTERS
): string {
  return run.checks.map((check, index) => {
    const label = labels[index]?.trim() || check.checkId;
    const exit = check.exitCode === null ? "no exit code" : `exit ${check.exitCode}`;
    const header = `${label}: ${check.status} (${exit}${check.truncated ? ", output truncated" : ""})`;
    const output = [check.stderr.trim(), check.stdout.trim()].filter(Boolean).join("\n");
    if (!output || maxOutputCharacters <= 0) return header;
    const bounded = output.length > maxOutputCharacters
      ? `… latest output …\n${output.slice(-maxOutputCharacters)}`
      : output;
    return `${header}\n${bounded}`;
  }).join("\n\n");
}
