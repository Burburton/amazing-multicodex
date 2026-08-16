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

## Install and use

Requirements:

- VS Code 1.90 or newer;
- Git and a local Git repository opened as the first workspace folder;
- a configured Codex CLI whose `codex app-server` command can start locally.

Build and install the extension:

```powershell
npm install
npm run package
code --install-extension ./amazing-multicodex-0.1.0.vsix
```

Reload VS Code, open Explorer, and find the `MultiCodex Tasks` view. Its empty
state links directly to task creation, runtime status, and extension settings.

The normal task flow is:

1. Create a draft with a title, context, acceptance criteria, and priority.
2. Optionally add prerequisites while the task is still a draft.
3. Queue the task. Ready tasks dispatch automatically up to the configured
   concurrency limit.
4. Open task details to follow execution and activity. Command and file-change
   approval requests appear as modal VS Code prompts.
5. Run validation, inspect the complete worktree diff, and integrate it with a
   merge or squash after review.
6. Release the isolated worktree after the task is completed or cancelled.

Search VS Code Settings for `Amazing MultiCodex` to configure the Codex
executable, default model, base ref, concurrency limit, timeouts, and ordered
validation commands. Commit or stash unrelated local changes before integrating
a completed task; integration intentionally requires a clean target repository.
