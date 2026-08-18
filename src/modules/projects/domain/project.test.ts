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

test("revises project metadata without changing repository identity", () => {
  const created = Project.create({
    id: "project" as ProjectId, name: "API", repositoryRoot: "/repo", baseRef: "main",
    createdAt: new Date(0), updatedAt: new Date(0)
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.value.revise({ name: " Backend ", baseRef: " develop ", now: new Date(1) }).ok, true);
  assert.deepEqual(created.value.snapshot(), {
    id: "project", name: "Backend", repositoryRoot: "/repo", baseRef: "develop",
    createdAt: new Date(0), updatedAt: new Date(1)
  });
});

test("rejects a base ref that can be parsed as a Git option", () => {
  const created = Project.create({
    id: "project" as ProjectId, name: "API", repositoryRoot: "/repo", baseRef: "--help",
    createdAt: new Date(0), updatedAt: new Date(0)
  });
  assert.equal(created.ok, false);
});
