import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GitState } from "./git.js";
import type { Metrics, ScenarioResult } from "./types.js";

/**
 * The reporter's history in its results folder:
 *
 *   runs-0001.ndjson.br, …   runs in the order they happened, one per line
 *   index.json               one entry per run, for filtering without opening the files
 */

export interface Run {
  date: string;
  git?: GitState;
  results: ScenarioResult[];
}

export interface IndexedScenario {
  status: ScenarioResult["status"];
  metrics: Metrics;
  budget: Metrics | null;
}

export interface IndexedRun {
  date: string;
  git?: GitState;
  /** The history file holding the full run. */
  file: string;
  scenarios: Record<string, IndexedScenario>;
}

export interface HistoryIndex {
  version: 1;
  runs: IndexedRun[];
}

/**
 * A file is compressed again whole on every run, so its uncompressed size is
 * capped to keep that around a tenth of a second.
 */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
const INDEX_FILE = "index.json";
const FILE_NUMBER_DIGITS = 4;

/** Seconds at the highest quality; a tenth of that at this one, for files about 30% bigger. */
const BROTLI_QUALITY = 5;
/** Brotli's largest window (16 MB), so each run can reuse what the runs before it share. */
const BROTLI_WINDOW_BITS = 24;
const COMPRESSION = {
  params: {
    [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
    [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
    [constants.BROTLI_PARAM_LGWIN]: BROTLI_WINDOW_BITS,
  },
};

const historyFileName = (number: number) => `runs-${String(number).padStart(FILE_NUMBER_DIGITS, "0")}.ndjson.br`;
const historyFileNumber = (file: string) => Number(/^runs-(\d+)/.exec(file)?.[1]);

function readLines(dir: string, file: string): string[] {
  const path = join(dir, file);
  if (!existsSync(path)) return [];
  return brotliDecompressSync(readFileSync(path)).toString("utf8").split("\n").filter(Boolean);
}

export function readHistoryFile(dir: string, file: string): Run[] {
  return readLines(dir, file).map((line) => JSON.parse(line) as Run);
}

const byteSize = (lines: string[]) => lines.reduce((total, line) => total + Buffer.byteLength(line) + 1, 0);

export function readIndex(dir: string): HistoryIndex {
  const path = join(dir, INDEX_FILE);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as HistoryIndex) : { version: 1, runs: [] };
}

export function readRun(dir: string, entry: IndexedRun): Run | undefined {
  return readHistoryFile(dir, entry.file).find((run) => run.date === entry.date);
}

export function readLatestRun(dir: string): Run | undefined {
  const latest = readIndex(dir).runs.at(-1);
  return latest && readRun(dir, latest);
}

/** Through a temporary file, so a crash midway never leaves a half-written file. */
function writeAtomically(path: string, data: string | Buffer): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, data);
  renameSync(temporary, path);
}

function indexEntryOf(run: Run, file: string): IndexedRun {
  const scenarios: Record<string, IndexedScenario> = {};
  for (const result of run.results) scenarios[result.key] = { status: result.status, metrics: result.metrics, budget: result.budget };
  return { date: run.date, git: run.git, file, scenarios };
}

/**
 * Appends a run to the newest history file, or starts the next one when the
 * run wouldn't fit. Not safe for two test runs saving into the same folder at once.
 */
export function recordRun(dir: string, run: Run): string {
  const index = readIndex(dir);
  const line = JSON.stringify(run);
  let file = index.runs.at(-1)?.file ?? historyFileName(1);
  let lines = readLines(dir, file);
  if (lines.length && byteSize(lines) + byteSize([line]) > MAX_FILE_BYTES) {
    file = historyFileName(historyFileNumber(file) + 1);
    lines = [];
  }
  lines.push(line);
  writeAtomically(join(dir, file), brotliCompressSync(lines.join("\n") + "\n", COMPRESSION));

  index.runs.push(indexEntryOf(run, file));
  writeAtomically(join(dir, INDEX_FILE), JSON.stringify(index) + "\n");
  return join(dir, file);
}
