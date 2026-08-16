import { Result } from "../../../shared/core/result";
import { WorkspaceRef } from "../../workspaces/public";

export type IntegrationStrategy = "merge" | "squash";

export interface IntegrateWorkspaceInput {
  readonly workspace: WorkspaceRef;
  readonly targetRepositoryRoot: string;
  readonly strategy: IntegrationStrategy;
  readonly commitMessage: string;
}

export interface IntegrationResult {
  readonly sourceCommit: string;
  readonly targetCommit: string;
  readonly strategy: IntegrationStrategy;
}

export interface IntegrationPort {
  integrate(input: IntegrateWorkspaceInput): Promise<Result<IntegrationResult>>;
}

