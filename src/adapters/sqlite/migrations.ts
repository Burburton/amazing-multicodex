import { SqliteMigration } from "../../shared/ports/sqlite";

export const sqliteMigrations: readonly SqliteMigration[] = [{
  version: 1,
  name: "core-control-plane",
  sql: `
CREATE TABLE IF NOT EXISTS kv_state (
  key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, repository_root TEXT NOT NULL UNIQUE,
  base_ref TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL, status TEXT NOT NULL,
  priority TEXT NOT NULL, payload_json TEXT NOT NULL, version INTEGER NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);
CREATE INDEX IF NOT EXISTS tasks_project_status ON tasks(project_id, status);
CREATE TABLE IF NOT EXISTS executions (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, status TEXT NOT NULL,
  payload_json TEXT NOT NULL, version INTEGER NOT NULL, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, FOREIGN KEY (task_id) REFERENCES tasks(id)
);
CREATE INDEX IF NOT EXISTS executions_task_updated ON executions(task_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, status TEXT NOT NULL,
  payload_json TEXT NOT NULL, version INTEGER NOT NULL, created_at TEXT NOT NULL,
  decided_at TEXT, FOREIGN KEY (task_id) REFERENCES tasks(id)
);
CREATE INDEX IF NOT EXISTS approvals_pending ON approvals(status, created_at);
CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, sequence INTEGER NOT NULL,
  payload_json TEXT NOT NULL, occurred_at TEXT NOT NULL,
  UNIQUE(task_id, sequence), FOREIGN KEY (task_id) REFERENCES tasks(id)
);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY, aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL,
  event_type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(delivered_at, created_at);
`
}];
