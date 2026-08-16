# Amazing MultiCodex

An orchestration control plane for running and reviewing multiple Codex tasks
across local Git projects inside VS Code.

The project is being rebuilt around a modular, adapter-driven architecture. See
[the architecture baseline](docs/architecture.md) for module boundaries,
dependency rules, runtime design, and delivery slices.

## Current status

The extension currently provides the core multi-task execution loop:

- persistent tasks, execution associations, approvals, and bounded activity;
- a persistent project registry with one repository root and base ref per project;
- a `MultiCodex Projects` dashboard with task, active-work, attention, and
  completion metrics plus clickable task drill-down;
- a `MultiCodex Tasks` Explorer view with create, start, resume, cancel, and
  activity commands;
- command-palette task selection filtered to the states accepted by each action;
- actionable runtime readiness checks for Codex, Git, and the configured base ref;
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
- confirmed task deletion that removes associated history, dependencies, and
  worktrees while retaining Git branches;
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

Reload VS Code, open Explorer, and find the `MultiCodex Projects` and
`MultiCodex Tasks` views. Workspace Git roots are registered automatically;
use `MultiCodex: Add Project` to register another local repository. Click a
project to open its dashboard and click any task row to drill into task details.
The task view's empty
state links directly to task creation, runtime status, and extension settings.
This Explorer view is the main visual interface: click a task to open its live
detail panel, use inline buttons for its next action, or right-click for all
available operations. The same operations are available from the Command
Palette (`Ctrl/Cmd+Shift+P`) under `MultiCodex:` and prompt for an eligible task.

The normal task flow is:

1. Create a task, choose its project, and, if needed, edit the draft with a
   title, context, acceptance criteria, and priority.
2. Optionally add prerequisites while the task is still a draft.
3. Queue the task. Ready tasks dispatch automatically up to the configured
   concurrency limit.
4. Open task details to follow execution and activity. Command and file-change
approval requests appear as modal VS Code prompts. While a connected task is
running, use `Send Follow-up` to clarify priorities without starting another turn.
After reloading VS Code or losing the Codex connection, use `Reconnect / Resume`
on a task that still shows as running.
5. Run validation, inspect the complete worktree diff, and integrate it with a
   merge or squash after review.
6. Release the isolated worktree after the task is completed or cancelled.

Stopped tasks can be deleted from their detail panel, tree context menu, or
`MultiCodex: Delete Task`. Deletion also removes the task's executions,
approvals, activity, and dependency edges. The confirmation warns before any
uncommitted worktree changes are discarded; the Git branch is retained. If a
cleanup step is interrupted, the task remains in `Deleting` state and exposes a
retry action instead of leaving partially active task state.

Search VS Code Settings for `Amazing MultiCodex` to configure the Codex
executable, default model, base ref, concurrency limit, timeouts, and ordered
validation commands. Commit or stash unrelated local changes before integrating
a completed task; integration intentionally requires a clean target repository.

## Troubleshooting

- Run `MultiCodex: Show Runtime Status` first. Each failed check offers the
  relevant settings or workspace action; a missing Codex CLI, non-Git folder,
  and unresolved base ref are reported separately.
- If Codex exits or VS Code reloads while a task is running, open that task and
  choose `Reconnect / Resume`. The existing worktree and Codex thread identity
  are retained in workspace storage.
- If integration says the target is dirty, commit or stash changes in the main
  repository and retry. MultiCodex never discards unrelated target changes.
- Cancelling validation stops the validation process tree and leaves the task
  ready to validate again. A timed-out check is reported as a failure instead.
- A blocked integration can be retried after fixing the cause. If Git already
  integrated the commit before the extension was interrupted, use
  `Recover Interrupted Integration` after verifying the target history.
