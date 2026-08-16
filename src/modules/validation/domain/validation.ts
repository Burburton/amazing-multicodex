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

export function validateProfile(profile: ValidationProfile): Result<ValidationProfile> {
  if (profile.checks.length === 0) {
    return err(validationError("validation.empty-profile", "Validation profile must contain a check."));
  }
  const ids = new Set<ValidationCheckId>();
  for (const check of profile.checks) {
    if (!check.label.trim() || !check.executable.trim()) {
      return err(validationError("validation.invalid-check", "Validation checks require a label and executable."));
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

