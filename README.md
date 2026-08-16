# Amazing MultiCodex

An orchestration control plane for running and reviewing multiple Codex tasks inside VS Code.

The project is being rebuilt around a modular, adapter-driven architecture. See
[the architecture baseline](docs/architecture.md) for module boundaries,
dependency rules, runtime design, and delivery slices.

## Current status

The extension currently provides the core multi-task execution loop:

- persistent tasks, execution associations, approvals, and bounded activity;
- a `MultiCodex Tasks` Explorer view with create, start, resume, cancel, and
  activity commands;
- one isolated Git worktree and branch per task execution;
- a supervised local Codex App Server connection over JSONL/stdio;
- streamed turn completion, agent response capture, and task-state recovery;
- modal command and file-change approvals with durable decisions;
- configurable sequential validation gates with persisted task transitions;
- persisted acyclic prerequisites and priority-aware automatic queue dispatch;
- draft-first task creation so dependencies can be configured before dispatch;
- complete worktree diff review, including committed and untracked changes;
- explicit merge or squash integration into a clean target repository;
- integration bound to the exact reviewed patch, with repository identity and
  output-truncation safety checks;
- explicit clean-worktree release;
- credential redaction before activity records are persisted;
- a reusable, action-enabled task-detail webview that refreshes after commands
  and when revealed;
- startup reconciliation for interrupted preparation and missing worktrees;
- bounded validation runtime, activity memory, and persisted activity size;
- automated module-boundary checks, unit/contract tests, and VSIX packaging.

Codex remains responsible for reasoning and code changes. This extension owns
coordination, worktrees, approvals, persistence, and observability. Execution
state currently uses VS Code workspace storage behind repository ports; the
planned SQLite adapter can replace it without changing the domain modules.

## Direction

```text
Task board → scheduler → Codex session adapter → isolated worktree
                    ↓
             tests / review / approval
```

Next milestones:

1. Add SQLite migrations and a transactional outbox.
2. Add live Codex thread-state reconciliation after reconnect.
3. Add guided conflict resolution and explicit retained-branch cleanup workflows.
4. Add protocol fixture compatibility checks across supported Codex versions.

## Development

```powershell
npm install
npm run check
npm test
npm run package
```

Press `F5` in VS Code to launch an Extension Development Host.
