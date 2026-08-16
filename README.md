# Amazing MultiCodex

An orchestration control plane for running and reviewing multiple Codex tasks inside VS Code.

The project is being rebuilt around a modular, adapter-driven architecture. See
[the architecture baseline](docs/architecture.md) for module boundaries,
dependency rules, runtime design, and delivery slices.

## Current status

The extension currently provides an early single-task execution loop:

- persistent tasks, execution associations, approvals, and bounded activity;
- a `MultiCodex Tasks` Explorer view with create, start, resume, cancel, and
  activity commands;
- one isolated Git worktree and branch per task execution;
- a supervised local Codex App Server connection over JSONL/stdio;
- streamed turn completion, agent response capture, and task-state recovery;
- modal command and file-change approvals with durable decisions;
- configurable sequential validation gates with persisted task transitions;
- complete worktree diff review, including committed and untracked changes;
- explicit merge or squash integration into a clean target repository;
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

1. Persist dependency graphs and add automatic queue scheduling.
2. Replace quick-pick activity with a task-detail webview.
3. Add SQLite migrations and full restart reconciliation.
4. Add conflict-resolution and safe worktree cleanup workflows.
5. Add protocol-generation compatibility checks across supported Codex versions.

## Development

```powershell
npm install
npm run check
npm test
npm run package
```

Press `F5` in VS Code to launch an Extension Development Host.
