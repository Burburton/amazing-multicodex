import { Clock } from "../../../shared/core/clock";
import { IdGenerator } from "../../../shared/core/idGenerator";
import { Result, ok } from "../../../shared/core/result";
import { Project, ProjectId, ProjectProps } from "../domain/project";
import { ProjectRepository } from "../ports/projectRepository";

export class ProjectService {
  constructor(private readonly repository: ProjectRepository, private readonly clock: Clock, private readonly ids: IdGenerator) {}

  async ensure(input: { name: string; repositoryRoot: string; baseRef: string }): Promise<Result<ProjectProps>> {
    const existing = await this.repository.findByRepositoryRoot(input.repositoryRoot);
    if (!existing.ok) return existing;
    if (existing.value) return ok(existing.value.snapshot());
    const now = this.clock.now();
    const created = Project.create({ id: this.ids.next() as ProjectId, ...input, createdAt: now, updatedAt: now });
    if (!created.ok) return created;
    const saved = await this.repository.save(created.value);
    return saved.ok ? ok(created.value.snapshot()) : saved;
  }

  async list(): Promise<Result<readonly ProjectProps[]>> {
    const listed = await this.repository.list();
    return listed.ok ? ok(listed.value.map(project => project.snapshot())) : listed;
  }
}
