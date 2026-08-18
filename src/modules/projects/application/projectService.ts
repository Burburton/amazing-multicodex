import { Clock } from "../../../shared/core/clock";
import { IdGenerator } from "../../../shared/core/idGenerator";
import { AppError, Result, err, ok } from "../../../shared/core/result";
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

  async revise(id: ProjectId, input: { name: string; baseRef: string }): Promise<Result<ProjectProps>> {
    const found = await this.repository.findById(id);
    if (!found.ok) return found;
    if (!found.value) return err(notFound(id));
    const revised = found.value.revise({ ...input, now: this.clock.now() });
    if (!revised.ok) return revised;
    const saved = await this.repository.save(found.value);
    return saved.ok ? ok(found.value.snapshot()) : saved;
  }

  async remove(id: ProjectId): Promise<Result<void>> {
    const found = await this.repository.findById(id);
    if (!found.ok) return found;
    if (!found.value) return err(notFound(id));
    return this.repository.delete(id);
  }
}

function notFound(id: ProjectId): AppError {
  return { code: "project.not-found", category: "validation", message: "Project was not found.", retryable: false, context: { id } };
}
