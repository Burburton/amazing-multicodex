import { Result, ok } from "../../../shared/core/result";
import { TaskDependency, TaskDependencyRepository } from "../ports/taskDependencyRepository";

export class InMemoryTaskDependencyRepository implements TaskDependencyRepository {
  private dependencies: readonly TaskDependency[] = [];
  async list(): Promise<Result<readonly TaskDependency[]>> { return ok([...this.dependencies]); }
  async replace(dependencies: readonly TaskDependency[]): Promise<Result<void>> {
    this.dependencies = [...dependencies];
    return ok(undefined);
  }
}

