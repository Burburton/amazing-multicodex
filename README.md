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
- complete worktree diff review, including committed and untracked changes;
- explicit merge or squash integration into a clean target repository;
- immutable reviewed-commit integration and explicit clean-worktree release;
- credential redaction before activity records are persisted;
- a read-only task-detail webview for criteria, dependencies, execution, and activity;
- startup reconciliation for interrupted preparation and missing worktrees;
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

1. Add validated task actions and live refresh to the detail webview.
2. Add SQLite migrations and Codex thread reconciliation after reconnect.
3. Add conflict-resolution and explicit retained-branch cleanup workflows.
4. Add protocol-generation compatibility checks across supported Codex versions.

## Development

```powershell
npm install
npm run check
npm test
npm run package
```

Press `F5` in VS Code to launch an Extension Development Host.
