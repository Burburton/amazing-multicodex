import * as vscode from "vscode";
import { createTask, MultiCodexTask } from "../domain/task";

const STORAGE_KEY = "amazingMultiCodex.tasks";

export class TaskStore {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  constructor(private readonly state: vscode.Memento) {}

  list(): MultiCodexTask[] {
    return this.state.get<MultiCodexTask[]>(STORAGE_KEY, []);
  }

  async add(title: string, description?: string): Promise<MultiCodexTask> {
    const task = createTask(title, description);
    await this.state.update(STORAGE_KEY, [task, ...this.list()]);
    this.changeEmitter.fire();
    return task;
  }

  async clear(): Promise<void> {
    await this.state.update(STORAGE_KEY, []);
    this.changeEmitter.fire();
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}
