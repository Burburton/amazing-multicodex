import { Brand } from "../../../shared/core/brand";
import { AppError, Result, err, ok } from "../../../shared/core/result";

export type ProjectId = Brand<string, "ProjectId">;

export interface ProjectProps {
  readonly id: ProjectId;
  readonly name: string;
  readonly repositoryRoot: string;
  readonly baseRef: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class Project {
  private constructor(private readonly props: ProjectProps) {}

  static create(props: ProjectProps): Result<Project> {
    const name = props.name.trim();
    const repositoryRoot = props.repositoryRoot.trim();
    const baseRef = props.baseRef.trim();
    if (!name || name.length > 200) return err(projectError("project.name-invalid", "Project name must contain 1 to 200 characters."));
    if (!repositoryRoot || repositoryRoot.length > 32_000) return err(projectError("project.path-invalid", "Project repository path is invalid."));
    if (!baseRef || baseRef.length > 1_024) return err(projectError("project.base-ref-invalid", "Project base ref is invalid."));
    return ok(new Project({ ...props, name, repositoryRoot, baseRef }));
  }

  static restore(props: ProjectProps): Project { return new Project({ ...props }); }
  snapshot(): ProjectProps { return { ...this.props }; }
}

function projectError(code: string, message: string): AppError {
  return { code, category: "validation", message, retryable: false };
}
