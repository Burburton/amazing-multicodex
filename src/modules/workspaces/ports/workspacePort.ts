import { Brand } from "../../../shared/core/brand";
import { Result } from "../../../shared/core/result";
import { TaskId } from "../../tasks/public";

export type WorkspaceId = Brand<string, "WorkspaceId">;

export interface WorkspaceRef {
  readonly id: WorkspaceId;
  readonly taskId: TaskId;
  readonly repositoryRoot: string;
  readonly worktreeRoot: string;
  readonly path: string;
  readonly branch: string;
  readonly baseRef: string;
}

export interface PrepareWorkspaceInput {
  readonly id: WorkspaceId;
  readonly taskId: TaskId;
  readonly repositoryRoot: string;
  readonly worktreeRoot: string;
  readonly branch: string;
  readonly baseRef: string;
}

export interface WorkspaceSnapshot extends WorkspaceRef {
  readonly headCommit: string;
  readonly dirty: boolean;
}

export interface ChangeSet {
  readonly workspaceId: WorkspaceId;
  readonly summary: string;
  readonly patch: string;
}

export interface ReleaseWorkspaceInput {
  readonly workspace: WorkspaceRef;
  readonly force: boolean;
}

export interface DeleteBranchInput {
  readonly repositoryRoot: string;
  readonly branch: string;
  readonly force: boolean;
}

export interface WorkspacePort {
  prepare(input: PrepareWorkspaceInput): Promise<Result<WorkspaceRef>>;
  inspect(workspace: WorkspaceRef): Promise<Result<WorkspaceSnapshot>>;
  diff(workspace: WorkspaceRef): Promise<Result<ChangeSet>>;
  release(input: ReleaseWorkspaceInput): Promise<Result<void>>;
  deleteBranch?(input: DeleteBranchInput): Promise<Result<void>>;
}
