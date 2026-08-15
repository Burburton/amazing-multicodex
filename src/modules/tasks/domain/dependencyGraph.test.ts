import assert from "node:assert/strict";
import test from "node:test";
import { TaskDependencyGraph } from "./dependencyGraph";
import { TaskId } from "./task";

const id = (value: string) => value as TaskId;

test("rejects dependency cycles", () => {
  const graph = new TaskDependencyGraph();
  assert.equal(graph.add(id("b"), id("a")).ok, true);
  const result = graph.add(id("a"), id("b"));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "task.dependency-cycle");
});

test("is runnable only when all prerequisites completed", () => {
  const graph = new TaskDependencyGraph([[id("c"), id("a")], [id("c"), id("b")]]);
  assert.equal(graph.isRunnable(id("c"), new Set([id("a")])), false);
  assert.equal(graph.isRunnable(id("c"), new Set([id("a"), id("b")])), true);
});

