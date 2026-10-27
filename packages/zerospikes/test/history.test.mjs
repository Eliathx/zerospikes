import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHistoryFile, readIndex, readLatestRun, readRun, recordRun, RUNS_PER_FILE } from "../dist/history.js";

const SCENARIO = "chromium › sort › click";
const git = { commit: "ae42f99", branch: "main", dirty: false };
const runAt = (date, status = "pass") => ({ date, git, results: [{ key: SCENARIO, status, metrics: { "frame.max": 40 } }] });
const emptyDir = () => mkdtempSync(join(tmpdir(), "zs-history-"));

test("each run is saved compressed and indexed with its commit", () => {
  const dir = emptyDir();
  recordRun(dir, runAt("2026-10-24T10:00:00.000Z"));
  recordRun(dir, runAt("2026-10-26T09:00:00.000Z", "fail"));
  assert.deepEqual(readdirSync(dir).sort(), ["index.json", "runs-0001.ndjson.br"]);
  assert.equal(readHistoryFile(dir, "runs-0001.ndjson.br").length, 2);

  const [first, second] = readIndex(dir).runs;
  assert.deepEqual(first.git, git);
  assert.deepEqual(second.scenarios[SCENARIO], { status: "fail", metrics: { "frame.max": 40 } });
  assert.equal(readRun(dir, first).date, "2026-10-24T10:00:00.000Z");
  assert.equal(readLatestRun(dir).date, "2026-10-26T09:00:00.000Z");
});

test("a full history file is left as is and the next run starts a new one", () => {
  const dir = emptyDir();
  const start = Date.parse("2026-10-26T00:00:00.000Z");
  for (let i = 0; i <= RUNS_PER_FILE; i++) recordRun(dir, runAt(new Date(start + i * 1000).toISOString()));
  assert.equal(readHistoryFile(dir, "runs-0001.ndjson.br").length, RUNS_PER_FILE);
  assert.equal(readHistoryFile(dir, "runs-0002.ndjson.br").length, 1);
  assert.equal(readIndex(dir).runs.at(-1).file, "runs-0002.ndjson.br");
});
