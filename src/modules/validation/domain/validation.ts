import { Brand } from "../../../shared/core/brand";
import { AppError, Result, err, ok } from "../../../shared/core/result";
import { WorkspaceId } from "../../workspaces/public";

export type ValidationRunId = Brand<string, "ValidationRunId">;
export type ValidationProfileId = Brand<string, "ValidationProfileId">;
export type ValidationCheckId = Brand<string, "ValidationCheckId">;
export type ValidationStatus = "passed" | "failed" | "cancelled";

export interface ValidationCheckDefinition {
  readonly id: ValidationCheckId;
  readonly label: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface ValidationProfile {
  readonly id: ValidationProfileId;
  readonly mode: "sequential" | "parallel";
  readonly checks: readonly ValidationCheckDefinition[];
}

export interface ValidationCheckResult {
  readonly checkId: ValidationCheckId;
  readonly status: ValidationStatus;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly startedAt: Date;
  readonly completedAt: Date;
}

export interface ValidationRun {
  readonly id: ValidationRunId;
  readonly workspaceId: WorkspaceId;
  readonly profileId: ValidationProfileId;
  readonly status: ValidationStatus;
  readonly checks: readonly ValidationCheckResult[];
  readonly startedAt: Date;
  readonly completedAt: Date;
}

const MAX_CHECKS = 50;
const MAX_LABEL_CHARACTERS = 200;
const MAX_EXECUTABLE_CHARACTERS = 4_096;
const MAX_ARGUMENTS = 200;
const MAX_ARGUMENT_CHARACTERS = 10_000;
const MAX_TIMEOUT_MS = 3_600_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

export function validateProfile(profile: ValidationProfile): Result<ValidationProfile> {
  if (!profile.id || profile.id.length > 1_000 || !["sequential", "parallel"].includes(profile.mode)) {
    return err(validationError("validation.invalid-profile", "Validation profile identity or mode is invalid."));
  }
  if (profile.checks.length === 0) {
    return err(validationError("validation.empty-profile", "Validation profile must contain a check."));
  }
  if (profile.checks.length > MAX_CHECKS) {
    return err(validationError("validation.too-many-checks", `Validation profiles cannot exceed ${MAX_CHECKS} checks.`));
  }
  const ids = new Set<ValidationCheckId>();
  for (const check of profile.checks) {
    if (!check.id || check.id.length > 1_000 || !check.label.trim() || !check.executable.trim()) {
      return err(validationError("validation.invalid-check", "Validation checks require a bounded identity, label, and executable."));
    }
    if (check.label.length > MAX_LABEL_CHARACTERS || check.executable.length > MAX_EXECUTABLE_CHARACTERS
      || check.args.length > MAX_ARGUMENTS || check.args.some(argument => argument.length > MAX_ARGUMENT_CHARACTERS)) {
      return err(validationError("validation.check-too-large", "Validation check labels, executables, or arguments exceed safe limits."));
    }
    if (check.timeoutMs !== undefined && (
      !Number.isInteger(check.timeoutMs) || check.timeoutMs < 1 || check.timeoutMs > MAX_TIMEOUT_MS
    )) {
      return err(validationError("validation.invalid-timeout", `Validation timeout must be between 1 and ${MAX_TIMEOUT_MS} ms.`));
    }
    if (check.maxOutputBytes !== undefined && (
      !Number.isInteger(check.maxOutputBytes) || check.maxOutputBytes < 1 || check.maxOutputBytes > MAX_OUTPUT_BYTES
    )) {
      return err(validationError("validation.invalid-output-limit", "Validation output limit must be between 1 byte and 10 MiB."));
    }
    if (ids.has(check.id)) {
      return err(validationError("validation.duplicate-check", "Validation check IDs must be unique."));
    }
    ids.add(check.id);
  }
  return ok(profile);
}

function validationError(code: string, message: string): AppError {
  return { code, category: "validation", message, retryable: false };
}
