# Amazing MultiCodex

An orchestration control plane for running and reviewing multiple Codex tasks inside VS Code.

## Current status

This repository starts with the control-plane foundation:

- a persistent task model;
- a `MultiCodex Tasks` Explorer view;
- task creation from the Command Palette or view title bar;
- explicit task lifecycle states ready for agent execution.

Codex execution is intentionally not duplicated here. The next integration boundary is a Codex App Server adapter, so Codex remains responsible for reasoning and code changes while this extension handles task coordination, worktrees, approvals, and observability.

## Direction

```text
Task board → scheduler → Codex session adapter → isolated worktree
                    ↓
             tests / review / approval
```

Planned milestones:

1. Connect queued tasks to Codex App Server sessions.
2. Add agent roles and task dependencies.
3. Create isolated Git worktrees per task.
4. Stream progress, approvals, and tool events into the task view.
5. Add test gates and human-approved merge flows.

## Development

```powershell
npm install
npm run check
npm run compile
```

Press `F5` in VS Code to launch an Extension Development Host.
