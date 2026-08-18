# Amazing MultiCodex Architecture

Status: accepted baseline, incrementally implemented
Last updated: 2026-08-16

## Implementation status

The module boundaries, project registry, task lifecycle, dependency-aware scheduler, Codex App
Server adapter, Git worktrees, approvals, validation, review, and explicit
integration workflows are implemented. Architecture dependencies are enforced
by `scripts/check-architecture.js` in `npm run check`.

Persistence currently uses validated VS Code `workspaceState` adapters behind
repository ports, with optimistic versions and serialized read-modify-write
operations. This is an intentional transitional implementation, not a change
to the SQLite decision in section 10. Lifecycle-driven dispatch, restart
reconciliation, safe workspace cleanup, and a reusable task-detail webview are
implemented. The current presentation includes a hierarchical Explorer tree
(`Project -> Tasks`), searchable project dashboards grouped by operator intent,
state-filtered Command Palette actions, editable drafts, task follow-ups, an
actionable readiness report, and a live-refreshing detail/activity panel.

External protocol lines, process output, persisted records, approval payloads,
and user-visible vendor errors have explicit size and redaction boundaries.
Approval requests and decisions are projected into the task activity timeline;
a separate approval inbox, transactional persistence/outbox, and live Codex
thread-state reconciliation remain future increments.

Per-task agent plans are persisted as ordered, bounded role pipelines and shown
in task details. Each stage runs in an independent Codex session against the
same isolated worktree. Execution records retain the current stage and bounded
prior agent identities, while the next role receives a bounded textual handoff.
Only the final successful stage advances the task to validation. Agent activity
is role-labelled, and a failed stage can be restarted in its existing worktree
through a compensated workflow that returns partial failures to a terminal
task state.

Reviewer stages publish an explicit terminal verdict. A changes-requested
verdict routes the same execution back to its Implementer stage with bounded
feedback, after which review repeats. The persisted review-cycle counter is
capped at three; exceeding the cap fails the execution with a diagnostic reason.

## 1. Purpose

Amazing MultiCodex is a VS Code control plane for coordinating multiple Codex
tasks. It owns task orchestration, isolated Git workspaces, approvals,
validation, observability, and user-directed integration. Codex remains the
execution engine responsible for reasoning and code changes.

The first product increment must support this reliable workflow:

```text
Create task
  -> prepare isolated worktree
  -> start or resume a Codex thread
  -> stream execution events
  -> resolve approvals
  -> run validation
  -> inspect result and diff
  -> explicitly integrate or discard
```

Automatic task decomposition and automatic merging are deliberately outside
the first increment.

## 2. Architectural style

The application starts as a **modular monolith** hosted by the VS Code
Extension Host. Internally it follows **hexagonal architecture**:

- domain modules contain business state and rules;
- application modules coordinate use cases;
- ports describe required capabilities;
- adapters implement ports using Codex App Server, Git, SQLite, the filesystem,
  processes, and VS Code;
- presentation modules translate UI intent into application commands and
  application projections into UI state.

This gives the project one deployable unit without turning it into one coupled
codebase. A module may only communicate through another module's public API or
published event contracts.

## 3. Dependency rule

Dependencies always point inward:

```text
Presentation ----> Application ----> Domain
                         |
                         v
                       Ports
                         ^
                         |
Infrastructure adapters + Host bootstrap
```

The rules are mandatory:

1. Domain code imports no VS Code, Node process, database, Git, Codex, or UI
   packages.
2. Application code depends on domain types and port interfaces, never concrete
   adapters.
3. Adapters may depend on vendor APIs but expose only project-owned types.
4. Presentation code never calls Git, Codex, SQLite, or the filesystem.
5. Cross-module imports target `public.ts`; importing another module's internal
   files is forbidden.
6. Vendor payloads are converted at adapter boundaries. JSON-RPC or VS Code
   types must not become domain models.
7. Business state changes occur through application commands, not through UI
   mutation or adapter callbacks.

These constraints are enforced with automated architecture tests rather than
relying on convention alone. ESLint import rules may be added as a second,
editor-time feedback layer.

## 4. System boundary

The product owns:

- local Git project identity and task-to-project assignment;
- task identity, lifecycle, priority, and dependencies;
- scheduling and concurrency policy;
- association between tasks, Codex threads, branches, and worktrees;
- approval records and user decisions;
- validation policy and results;
- normalized execution events and read models;
- recovery after extension restart;
- explicit integration and cleanup workflows.

The product does not own:

- model reasoning or tool execution semantics;
- Codex conversation storage internals;
- Git's merge algorithm;
- arbitrary CI infrastructure;
- source-control hosting or pull requests in the initial release.

## 5. Bounded modules

### 5.1 `projects`

Owns the local Git repositories managed by the control plane.

Responsibilities:

- register a repository root, display name, and base ref;
- revise display metadata and safely remove an empty registration;
- provide stable project identities for task assignment;
- keep project persistence behind a repository port;
- support project-level status projections without coupling the domain to UI.

The project module does not inspect Git itself or know how tasks are rendered.
Git-root validation belongs to the host/adapters and aggregate metrics are UI
projections over task snapshots.

### 5.2 `tasks`

Owns the user-visible unit of work.

Responsibilities:

- create, edit, queue, cancel, archive, and retry tasks;
- maintain lifecycle invariants;
- store task priority and acceptance criteria;
- define dependency relationships;
- determine whether prerequisites are satisfied.

Core types:

```ts
type TaskId = string & { readonly __brand: "TaskId" };

type TaskStatus =
  | "draft"
  | "queued"
  | "preparing"
  | "running"
  | "awaitingApproval"
  | "validating"
  | "readyForReview"
  | "integrating"
  | "completed"
  | "blocked"
  | "failed"
  | "cancelled";
```

`tasks` does not know how Codex runs, how a worktree is created, or how the UI
renders a task.

Task definitions are movable only while still drafts. Dependency edges may not
cross project boundaries, keeping scheduling, worktree ownership, and
integration repositories unambiguous.

### 5.3 `orchestration`

Owns workflow coordination across modules.

Responsibilities:

- select runnable tasks;
- enforce configurable concurrency limits;
- coordinate prepare, execute, validate, and integrate phases;
- retry recoverable operations according to policy;
- use idempotency keys for long-running actions;
- recover incomplete workflows after restart.

The scheduler works with task IDs and declared capabilities. It does not spawn
processes or manipulate worktrees directly.

Initial scheduling policy:

1. prerequisites completed;
2. higher priority first;
3. FIFO within equal priority;
4. one active execution per task;
5. one active task per worktree;
6. global concurrency limit defaults to two.

### 5.4 `agents`

Owns the product-level representation of an agent execution session.

Responsibilities:

- start, resume, steer, interrupt, and observe an execution;
- map task execution to a Codex thread and current turn;
- normalize streamed items into stable project events;
- track connection and execution state independently;
- expose model and collaboration-mode capabilities.
- own validated task role plans (`planner`, `implementer`, `reviewer`, and
  `tester`) independently from runtime session records.

This module defines `AgentRuntimePort`. The Codex adapter implements it. No
other module knows about JSON-RPC methods such as `thread/start` or
`turn/start`.

### 5.5 `workspaces`

Owns isolated execution environments.

Responsibilities:

- create and discover task branches and worktrees;
- verify repository preconditions;
- report changed files and diff summaries;
- detect conflicts and dirty state;
- safely release or retain a task workspace;
- prevent two tasks from owning the same path.

Destructive cleanup is never implicit. Cleanup requires an explicit command and
a successful safety check.

### 5.6 `approvals`

Owns durable approval requests and decisions.

Responsibilities:

- record requests from agent execution;
- classify scope and risk;
- present a stable request even if the runtime disconnects;
- ensure exactly one terminal decision;
- return the decision to the waiting runtime;
- retain an audit record.

Approval transport is separated from approval policy. The Codex adapter carries
the response; this module decides whether a decision exists and who may make it.

### 5.7 `validation`

Owns quality gates.

Responsibilities:

- define ordered or parallel validation checks;
- execute checks through a command runner port;
- capture exit status, duration, and bounded output;
- determine overall pass, fail, or cancelled status;
- allow project-level configuration without embedding shell commands in domain
  entities.

A validation profile references immutable check definitions. A task stores the
profile ID and result snapshot used for its review.

### 5.8 `integration`

Owns promotion of reviewed work.

Responsibilities:

- verify that the reviewed commit and validation snapshot are still current;
- detect target-branch movement and conflicts;
- perform an explicitly selected integration strategy;
- record the resulting commit or conflict state;
- never merge automatically in the first release.

Supported initial strategies should be `merge` and `squash`; rebase can be
added after conflict recovery is designed.

### 5.9 `activity`

Owns the normalized append-only activity timeline and UI read projections.

Responsibilities:

- accept stable domain and execution events;
- persist ordered activity records;
- build task list, task detail, approval inbox, and runtime health projections;
- bound large command output and delta streams;
- support replay after UI reload.

Activity records are observations, not the source of truth for task state.
Authoritative state lives in module repositories.

### 5.10 `settings`

Owns validated application configuration.

Responsibilities:

- concurrency and retry policy;
- Codex executable and connection settings;
- branch/worktree naming policy;
- validation profiles;
- retention and output limits;
- feature flags for experimental capabilities.

VS Code configuration is an adapter input. The rest of the application receives
a project-owned settings snapshot.

## 6. Public module contracts

Each module has the same internal shape where applicable:

```text
modules/<name>/
  domain/          entities, value objects, invariants, domain events
  application/     commands, queries, handlers, module services
  ports/           repository and capability interfaces
  public.ts        the only cross-module import surface
```

Adapters and host code live outside the modules:

```text
src/
  modules/
    tasks/
    orchestration/
    agents/
    workspaces/
    approvals/
    validation/
    integration/
    activity/
    settings/
  adapters/
    codex-app-server/
    git-cli/
    sqlite/
    process/
    vscode/
  presentation/
    commands/
    tree/
    webview/
  host/
    composition-root.ts
    extension.ts
```

`public.ts` should export use-case contracts and stable DTOs, not entities with
public setters or adapter implementations.

## 7. Command, query, and event model

Use explicit commands for intent, queries for reads, and events for facts.

Examples:

```ts
type StartTask = {
  taskId: TaskId;
  expectedVersion: number;
  idempotencyKey: string;
};

type TaskSummary = {
  id: TaskId;
  title: string;
  status: TaskStatus;
  activePhase?: string;
  updatedAt: string;
};

type TaskExecutionStarted = {
  type: "task.execution-started";
  taskId: TaskId;
  executionId: ExecutionId;
  occurredAt: string;
};
```

Use an in-process event bus for decoupling module reactions. Durable changes and
outgoing events must be committed atomically through a transactional outbox.
The outbox dispatcher retries delivery; handlers must therefore be idempotent.

Do not build full event sourcing initially. A relational state model plus an
append-only activity log provides recovery and observability with much lower
complexity.

## 8. Essential ports

Project-owned ports establish replacement boundaries:

```ts
interface AgentRuntimePort {
  start(input: StartExecutionInput): Promise<AgentExecutionRef>;
  resume(input: ResumeExecutionInput): Promise<AgentExecutionRef>;
  steer(input: SteerExecutionInput): Promise<void>;
  interrupt(executionId: ExecutionId): Promise<void>;
  respondToApproval(input: ApprovalDecisionInput): Promise<void>;
  events(executionId: ExecutionId): AsyncIterable<AgentRuntimeEvent>;
  health(): Promise<RuntimeHealth>;
}

interface WorkspacePort {
  prepare(input: PrepareWorkspaceInput): Promise<WorkspaceRef>;
  inspect(workspaceId: WorkspaceId): Promise<WorkspaceSnapshot>;
  diff(workspaceId: WorkspaceId): Promise<ChangeSet>;
  release(input: ReleaseWorkspaceInput): Promise<void>;
}

interface CommandRunnerPort {
  run(input: CommandSpec, signal: AbortSignal): Promise<CommandResult>;
}

interface UnitOfWork {
  run<T>(operation: (tx: TransactionContext) => Promise<T>): Promise<T>;
}

interface Clock {
  now(): Date;
}

interface IdGenerator {
  next(): string;
}
```

Time, IDs, subprocesses, and persistence are ports so tests remain deterministic.

## 9. Codex adapter boundary

The Codex App Server adapter has four internal layers:

```text
process supervisor
  -> JSON-RPC transport
  -> version-specific generated protocol client
  -> project event mapper implementing AgentRuntimePort
```

Rules:

- use `stdio` transport first;
- generate protocol types from the installed Codex version;
- keep generated types inside the adapter;
- perform `initialize`/`initialized` once per connection;
- correlate requests by ID and bound pending requests;
- normalize thread, turn, item, approval, and failure notifications;
- distinguish runtime disconnection from task failure;
- use exponential backoff with jitter for restart attempts;
- reconcile stored executions with Codex threads after reconnect;
- do not enable experimental APIs for core MVP behavior.

The adapter publishes normalized events such as:

```ts
type AgentRuntimeEvent =
  | AgentMessageDelta
  | CommandStarted
  | CommandOutputDelta
  | CommandCompleted
  | FileChangeObserved
  | ApprovalRequested
  | ExecutionCompleted
  | RuntimeDisconnected;
```

## 10. Persistence model

Use SQLite through repository adapters. Database records are not domain
entities. Minimum logical tables:

```text
tasks
task_dependencies
task_executions
agent_sessions
workspaces
approval_requests
validation_runs
validation_checks
integration_attempts
activity_events
outbox_events
schema_migrations
```

Every mutable aggregate has a numeric `version` for optimistic concurrency.
Timestamps use UTC ISO-8601 at boundaries. Raw high-volume stream deltas should
be coalesced before persistence, while terminal events remain lossless.

VS Code `workspaceState` is unsuitable as the primary store because it lacks
transactions, queryability, migrations, and robust large-history handling. It
may retain UI preferences only.

## 11. Runtime lifecycle and recovery

Extension activation follows this order:

1. load and validate settings;
2. open the database and run migrations;
3. start the outbox dispatcher;
4. start and initialize the Codex runtime adapter;
5. reconcile non-terminal executions and worktrees;
6. start the scheduler;
7. register presentation commands and views.

Shutdown reverses the order and uses bounded deadlines. It does not delete
worktrees or mark active tasks failed merely because VS Code closed.

On recovery:

- a known active turn is resumed or observed;
- an existing thread without an active turn becomes resumable;
- a missing worktree blocks its task with a repair action;
- a runtime outage sets runtime health degraded, not every task failed;
- operations interrupted between intent and completion are replayed from the
  outbox or reconciled using their idempotency key.

## 12. Task state machine

Only the `tasks` module may change task status. Transitions are explicit:

```text
draft -> queued -> preparing -> running
                               -> awaitingApproval -> running
                               -> validating -> readyForReview
readyForReview -> integrating -> completed

Any active state -> blocked | failed | cancelled
blocked -> queued
blocked -> readyForReview (integration recovery only)
failed  -> queued
cancelled -> queued
```

`blocked` means user or environmental action is required. `failed` means an
attempt ended unsuccessfully. A runtime disconnect alone is neither.

Each transition records a reason code and human-readable detail. UI labels are
derived from reason codes rather than parsing error strings.

## 13. UI boundary

Presentation is replaceable and contains no workflow logic.

Target surfaces (the approval inbox remains planned):

- task board/tree: task status, priority, dependencies, active phase;
- task detail webview: prompt, timeline, changed files, validation, actions;
- approval inbox: pending requests and scoped decisions;
- runtime status: executable, repository, base ref, connection, and actionable
  remediation. Authentication and richer degraded-state telemetry remain planned.

Webviews communicate with the extension through versioned messages validated at
runtime. They issue commands and subscribe to projections; they never receive
repositories or adapter instances.

## 14. Error model

Every module returns project-owned typed errors:

```ts
type AppError = {
  code: string;
  category: "validation" | "conflict" | "unavailable" | "permission" | "internal";
  message: string;
  retryable: boolean;
  context?: Record<string, string>;
  cause?: unknown;
};
```

Adapters translate vendor failures once at the boundary. UI maps error codes to
actions. Logs may contain diagnostic causes; user-facing projections must not
leak secrets or raw environment data.

## 15. Testing strategy

### Unit tests

- state transitions and invariants;
- dependency-cycle prevention;
- scheduling fairness and concurrency;
- approval decision rules;
- validation aggregation;
- recovery decisions.

Use in-memory fake ports, fake clocks, and deterministic IDs.

### Contract tests

- every repository implementation against a shared repository suite;
- Git adapter against temporary repositories;
- Codex protocol mapping against recorded and synthetic JSON-RPC fixtures;
- webview message schemas in both directions.

### Integration tests

- SQLite migrations and transactional outbox;
- process supervision and reconnect behavior;
- end-to-end task execution with a fake Agent Runtime;
- optional smoke tests against an installed Codex App Server.

The main end-to-end suite must not require network access or consume model
quota.

## 16. Security and safety

- pass prompts and commands as structured arguments, never shell-concatenated
  strings;
- keep credentials in Codex/OS-managed storage, not the project database;
- redact known secrets from activity output;
- cap protocol lines, process output, persisted records, and UI message size;
- bind any future socket transport to loopback by default;
- require explicit confirmation for integration and destructive cleanup;
- verify paths are descendants of the configured worktree root;
- preserve an audit trail for approvals and integration attempts.

## 17. Delivery slices

### Slice A: architecture enforcement

- establish module directories and public APIs;
- introduce domain IDs, result/error types, clock, and event bus contracts;
- add import-boundary lint rules and architecture tests;
- provide an in-memory task repository for fast tests.

### Slice B: single-task execution

- SQLite repositories and migrations;
- Codex process supervisor and stable protocol adapter;
- task creation, one execution, streaming activity, interruption, and recovery;
- minimal task tree and detail view.

### Slice C: isolated workspace and approvals

- Git worktree lifecycle;
- durable approval inbox and responses;
- diff projection and safe cleanup;
- failure repair actions.

### Slice D: validation and review

- configurable validation profiles;
- command output and result projections;
- reviewed commit snapshot;
- explicit merge/squash integration.

### Slice E: multi-task scheduling

- dependency graph and cycle detection;
- concurrency-aware scheduler;
- retry and cancellation policies;
- board-level observability.

Each slice must leave the application usable and preserve the dependency rule.

## 18. Architectural decisions

The following decisions are accepted as the initial baseline:

1. Modular monolith before multiple processes or services.
2. Hexagonal boundaries with project-owned ports.
3. Codex App Server via local `stdio` for rich interactive execution.
4. SQLite for authoritative local state; VS Code state for UI preferences only.
5. Relational aggregates plus activity log and transactional outbox, not full
   event sourcing.
6. One worktree per task execution lineage.
7. Explicit human integration in the initial release.
8. Stable Codex App Server APIs only for MVP-critical paths.

Any change to these decisions requires a short ADR describing context,
alternatives, consequences, and migration impact.

## 19. Definition of architectural compliance

A feature is not complete unless:

- domain and application tests run without VS Code or Codex;
- vendor types remain within their adapter;
- cross-module calls use public contracts;
- state changes are expressed as commands and persisted transactionally;
- long-running actions are idempotent and recoverable;
- failures have typed codes and actionable recovery behavior;
- lifecycle cleanup is explicit and safe;
- the feature includes observability sufficient to explain its current state.
