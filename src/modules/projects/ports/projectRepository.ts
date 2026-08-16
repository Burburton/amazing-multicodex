import { Result } from "../../../shared/core/result";
import { Project, ProjectId } from "../domain/project";

export interface ProjectRepository {
  list(): Promise<Result<readonly Project[]>>;
  findById(id: ProjectId): Promise<Result<Project | undefined>>;
  findByRepositoryRoot(root: string): Promise<Result<Project | undefined>>;
  save(project: Project): Promise<Result<void>>;
}
