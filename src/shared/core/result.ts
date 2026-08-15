export type AppErrorCategory =
  | "validation"
  | "conflict"
  | "unavailable"
  | "permission"
  | "internal";

export interface AppError {
  readonly code: string;
  readonly category: AppErrorCategory;
  readonly message: string;
  readonly retryable: boolean;
  readonly context?: Readonly<Record<string, string>>;
  readonly cause?: unknown;
}

export type Result<T, E = AppError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

