import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveWorkerConfig, withPatch } from "../src/worker-config.js";

test("resolveWorkerConfig: later layers override earlier ones (task overrides worker overrides pipeline)", () => {
  const result = resolveWorkerConfig(
    { temperature: 0.1, model: "pipeline-model" },
    { temperature: 0.2, model: "worker-model" },
    { temperature: 0.7, model: "task-model" }
  );
  assert.equal(result.temperature, 0.7);
  assert.equal(result.model, "task-model");
});

test("resolveWorkerConfig: does not mutate any input object", () => {
  const pipeline = { temperature: 0.1, model: "pipeline-model" };
  const worker = { temperature: 0.2, model: "worker-model" };
  const task = { temperature: 0.7, model: "task-model" };

  const beforePipeline = JSON.parse(JSON.stringify(pipeline));
  const beforeWorker = JSON.parse(JSON.stringify(worker));
  const beforeTask = JSON.parse(JSON.stringify(task));

  resolveWorkerConfig(pipeline, worker, task);

  assert.deepStrictEqual(pipeline, beforePipeline);
  assert.deepStrictEqual(worker, beforeWorker);
  assert.deepStrictEqual(task, beforeTask);
});

test("withPatch: returns a new object with patch keys applied without mutating base", () => {
  const base = { temperature: 0.5, model: "base-model", top_p: 0.9 };
  const patch = { temperature: 0.8, new_key: "hello" };

  const before = JSON.parse(JSON.stringify(base));
  const patched = withPatch(base, patch);

  assert.notStrictEqual(patched, base, "withPatch must return a new object");
  assert.equal(patched.temperature, 0.8);
  assert.equal(patched.new_key, "hello");
  assert.equal(patched.top_p, 0.9);
  assert.deepStrictEqual(base, before, "base must not be mutated");
});

test("resolveWorkerConfig: throws when num_ctx appears in any layer", () => {
  assert.throws(() =>
    resolveWorkerConfig({ num_ctx: 4096 }, { temperature: 0.2 })
  );
  assert.throws(() =>
    resolveWorkerConfig({ temperature: 0.2 }, { num_ctx: 4096 })
  );
  assert.throws(() =>
    resolveWorkerConfig({ temperature: 0.2 }, { numCtx: 4096 })
  );
});

test("resolveWorkerConfig: throws when keep_alive / keepAlive appears in any layer", () => {
  assert.throws(() =>
    resolveWorkerConfig({ keep_alive: 300 }, { temperature: 0.2 })
  );
  assert.throws(() =>
    resolveWorkerConfig({ temperature: 0.2 }, { keep_alive: 300 })
  );
  assert.throws(() =>
    resolveWorkerConfig({ temperature: 0.2 }, { keepAlive: 300 })
  );
});

test("resolveWorkerConfig: throws when unload/reload flags appear", () => {
  assert.throws(() =>
    resolveWorkerConfig({ unload: true }, { temperature: 0.2 })
  );
  assert.throws(() =>
    resolveWorkerConfig({ temperature: 0.2 }, { reload: true })
  );
});
