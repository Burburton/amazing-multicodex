import * as path from "node:path";
import { Project, ProjectId, ProjectProps, ProjectRepository } from "../../modules/projects/public";
import { AppError, Result, err, ok } from "../../shared/core/result";
import { KeyValueState } from "../../shared/ports/keyValueState";
import { AsyncOperationQueue } from "../../shared/core/asyncOperationQueue";

interface StoredProject extends Omit<ProjectProps, "createdAt" | "updatedAt"> { readonly createdAt: string; readonly updatedAt: string }
const STORAGE_KEY = "amazingMultiCodex.projects.v1";
const MAX_PROJECTS = 500;

export class MementoProjectRepository implements ProjectRepository {
  private readonly writes = new AsyncOperationQueue();
  constructor(private readonly state: KeyValueState) {}
  async list(): Promise<Result<readonly Project[]>> {
    const records = this.records();
    return records.ok ? ok(records.value.map(item => Project.restore(toProps(item)))) : records;
  }
  async findById(id: ProjectId): Promise<Result<Project | undefined>> {
    const records = this.records();
    if (!records.ok) return records;
    const found = records.value.find(item => item.id === id);
    return ok(found ? Project.restore(toProps(found)) : undefined);
  }
  async findByRepositoryRoot(root: string): Promise<Result<Project | undefined>> {
    const normalized = path.resolve(root);
    const records = this.records();
    if (!records.ok) return records;
    const found = records.value.find(item => path.resolve(item.repositoryRoot) === normalized);
    return ok(found ? Project.restore(toProps(found)) : undefined);
  }
  async save(project: Project): Promise<Result<void>> {
    return this.writes.run(async () => {
      const records = this.records();
      if (!records.ok) return records;
      const stored = toStored(project.snapshot());
      if (!isStoredProject(stored)) return err(invalidState("project.record-invalid", "Project fields exceed safe limits."));
      const duplicate = records.value.find(item => path.resolve(item.repositoryRoot) === path.resolve(stored.repositoryRoot) && item.id !== stored.id);
      if (duplicate) return err(invalidState("project.repository-duplicate", "This repository is already registered."));
      const index = records.value.findIndex(item => item.id === stored.id);
      if (index === -1) {
        if (records.value.length >= MAX_PROJECTS) return err(invalidState("project.capacity-exceeded", "Project capacity has been reached."));
        records.value.push(stored);
      } else records.value[index] = stored;
      try { await this.state.update(STORAGE_KEY, records.value); return ok(undefined); }
      catch (cause) { return err(persistenceError(cause)); }
    });
  }
  private records(): Result<StoredProject[]> {
    try {
      const stored = this.state.get<unknown>(STORAGE_KEY, []);
      if (!Array.isArray(stored) || stored.length > MAX_PROJECTS || !stored.every(isStoredProject)
        || new Set(stored.map(item => item.id)).size !== stored.length) return err(invalidState("project.state-invalid", "Stored project state is invalid."));
      return ok([...stored]);
    } catch (cause) { return err(persistenceError(cause)); }
  }
}

function isStoredProject(value: unknown): value is StoredProject {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return bounded(item.id, 1_000) && bounded(item.name, 200) && bounded(item.repositoryRoot, 32_000)
    && bounded(item.baseRef, 1_024) && validDate(item.createdAt) && validDate(item.updatedAt);
}
function bounded(value: unknown, max: number): value is string { return typeof value === "string" && value.length > 0 && value.length <= max; }
function validDate(value: unknown): value is string { return typeof value === "string" && !Number.isNaN(Date.parse(value)); }
function toStored(props: ProjectProps): StoredProject { return { ...props, createdAt: props.createdAt.toISOString(), updatedAt: props.updatedAt.toISOString() }; }
function toProps(item: StoredProject): ProjectProps { return { ...item, id: item.id as ProjectId, createdAt: new Date(item.createdAt), updatedAt: new Date(item.updatedAt) }; }
function invalidState(code: string, message: string): AppError { return { code, category: "validation", message, retryable: false }; }
function persistenceError(cause: unknown): AppError { return { code: "project.persistence-failed", category: "unavailable", message: "Project state could not be persisted.", retryable: true, cause }; }
