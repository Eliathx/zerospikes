import { spawnSync } from "node:child_process";

/** The code a run measured. */
export interface GitState {
  commit: string;
  /** Missing on a detached checkout outside GitHub Actions. */
  branch?: string;
  /** Whether there were uncommitted changes, so the run measured more than the commit. */
  dirty: boolean;
}

function git(cwd: string, ...args: string[]): string | undefined {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/** The checkout `cwd` is in, or undefined outside a git repository. */
export function readGitState(cwd: string): GitState | undefined {
  const commit = git(cwd, "rev-parse", "HEAD");
  if (!commit) return undefined;
  const head = git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
  // CI checks out a detached commit; GitHub Actions names the branch in these.
  const branch = head && head !== "HEAD" ? head : process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || undefined;
  return { commit, branch, dirty: Boolean(git(cwd, "status", "--porcelain")) };
}
