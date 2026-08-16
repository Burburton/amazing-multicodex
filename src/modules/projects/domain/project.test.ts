import assert from "node:assert/strict";
import test from "node:test";
import { Project, ProjectId } from "./project";

test("normalizes valid project metadata", () => {
  const created = Project.create({
    id: "project" as ProjectId, name: " API ", repositoryRoot: " /repo ", baseRef: " main ",
    createdAt: new Date(0), updatedAt: new Date(0)
  });
  assert.equal(created.ok, true);
  if (created.ok) assert.deepEqual(created.value.snapshot(), {
    id: "project", name: "API", repositoryRoot: "/repo", baseRef: "main",
    createdAt: new Date(0), updatedAt: new Date(0)
  });
});

test("rejects unsafe project metadata sizes", () => {
  const created = Project.create({
    id: "project" as ProjectId, name: "x".repeat(201), repositoryRoot: "/repo", baseRef: "main",
    createdAt: new Date(0), updatedAt: new Date(0)
  });
  assert.equal(created.ok, false);
});
