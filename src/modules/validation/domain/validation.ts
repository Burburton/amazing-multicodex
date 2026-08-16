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

export function validateProfile(profile: ValidationProfile): Result<ValidationProfile> {
  if (profile.checks.length === 0) {
    return err(validationError("validation.empty-profile", "Validation profile must contain a check."));
  }
  if (profile.checks.length > MAX_CHECKS) {
    return err(validationError("validation.too-many-checks", `Validation profiles cannot exceed ${MAX_CHECKS} checks.`));
  }
  const ids = new Set<ValidationCheckId>();
  for (const check of profile.checks) {
    if (!check.label.trim() || !check.executable.trim()) {
      return err(validationError("validation.invalid-check", "Validation checks require a label and executable."));
    }
    if (check.label.length > MAX_LABEL_CHARACTERS || check.executable.length > MAX_EXECUTABLE_CHARACTERS
      || check.args.length > MAX_ARGUMENTS || check.args.some(argument => argument.length > MAX_ARGUMENT_CHARACTERS)) {
      return err(validationError("validation.check-too-large", "Validation check labels, executables, or arguments exceed safe limits."));
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
