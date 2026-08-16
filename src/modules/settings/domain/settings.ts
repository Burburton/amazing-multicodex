import { AppError, Result, err, ok } from "../../../shared/core/result";

export interface MultiCodexSettings {
  readonly codexExecutable: string;
  readonly defaultModel?: string;
  readonly requestTimeoutMs: number;
  readonly baseRef: string;
  readonly concurrencyLimit: number;
  readonly maxActivityCharacters: number;
  readonly validationTimeoutMs: number;
  readonly validationCommands: readonly ValidationCommandSetting[];
}

export interface ValidationCommandSetting {
  readonly label: string;
  readonly executable: string;
  readonly args: readonly string[];
}

export type SettingsInput = Partial<MultiCodexSettings>;

export const defaultSettings: MultiCodexSettings = {
  codexExecutable: "codex",
  requestTimeoutMs: 30_000,
  baseRef: "HEAD",
  concurrencyLimit: 2,
  maxActivityCharacters: 32_000,
  validationTimeoutMs: 900_000,
  validationCommands: [
    { label: "Git whitespace check", executable: "git", args: ["diff", "--check"] }
  ]
};

export function parseSettings(input: SettingsInput): Result<MultiCodexSettings> {
  if (input.codexExecutable !== undefined && typeof input.codexExecutable !== "string") {
    return err(settingError("settings.codex-executable", "Codex executable must be a string."));
  }
  if (input.defaultModel !== undefined && typeof input.defaultModel !== "string") {
    return err(settingError("settings.default-model", "Default model must be a string."));
  }
  if (input.baseRef !== undefined && typeof input.baseRef !== "string") {
    return err(settingError("settings.base-ref", "Git base ref must be a string."));
  }
  if (input.validationCommands !== undefined && !Array.isArray(input.validationCommands)) {
    return err(settingError("settings.validation-commands", "Validation commands must be an array."));
  }
  const value: MultiCodexSettings = {
    codexExecutable: input.codexExecutable ?? defaultSettings.codexExecutable,
    defaultModel: input.defaultModel?.trim() || undefined,
    requestTimeoutMs: input.requestTimeoutMs ?? defaultSettings.requestTimeoutMs,
    baseRef: input.baseRef ?? defaultSettings.baseRef,
    concurrencyLimit: input.concurrencyLimit ?? defaultSettings.concurrencyLimit,
    maxActivityCharacters: input.maxActivityCharacters ?? defaultSettings.maxActivityCharacters,
    validationTimeoutMs: input.validationTimeoutMs ?? defaultSettings.validationTimeoutMs,
    validationCommands: input.validationCommands ?? defaultSettings.validationCommands
  };
  if (!value.codexExecutable.trim()) return err(settingError("settings.codex-executable", "Codex executable cannot be empty."));
  if (!value.baseRef.trim()) return err(settingError("settings.base-ref", "Git base ref cannot be empty."));
  if (!Number.isInteger(value.concurrencyLimit) || value.concurrencyLimit < 1 || value.concurrencyLimit > 16) {
    return err(settingError("settings.concurrency-limit", "Concurrency limit must be an integer from 1 to 16."));
  }
  if (!Number.isInteger(value.requestTimeoutMs) || value.requestTimeoutMs < 1_000 || value.requestTimeoutMs > 300_000) {
    return err(settingError("settings.request-timeout", "Request timeout must be between 1,000 and 300,000 ms."));
  }
  if (!Number.isInteger(value.maxActivityCharacters) || value.maxActivityCharacters < 1_000 || value.maxActivityCharacters > 200_000) {
    return err(settingError("settings.activity-limit", "Activity message limit must be between 1,000 and 200,000 characters."));
  }
  if (!Number.isInteger(value.validationTimeoutMs) || value.validationTimeoutMs < 1_000 || value.validationTimeoutMs > 3_600_000) {
    return err(settingError("settings.validation-timeout", "Validation timeout must be between 1,000 and 3,600,000 ms."));
  }
  if (value.validationCommands.length === 0 || !value.validationCommands.every(isValidationCommand)) {
    return err(settingError("settings.validation-commands", "At least one valid validation command is required."));
  }
  return ok({
    ...value,
    codexExecutable: value.codexExecutable.trim(),
    baseRef: value.baseRef.trim()
  });
}

function isValidationCommand(command: unknown): command is ValidationCommandSetting {
  if (!command || typeof command !== "object") return false;
  const value = command as Record<string, unknown>;
  return typeof value.label === "string" && value.label.trim().length > 0
    && typeof value.executable === "string" && value.executable.trim().length > 0
    && Array.isArray(value.args) && value.args.every(argument => typeof argument === "string");
}

function settingError(code: string, message: string): AppError {
  return { code, category: "validation", message, retryable: false };
}
