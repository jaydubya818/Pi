// Git worktree per sub-agent. One agent, one branch, one filesystem.
// Symlinks heavy dirs (node_modules, .venv) so 5 agents don't eat 5x disk.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";

const exec = promisify(execFile);

const SLUG_RE = /^[a-z0-9][a-z0-9-_]{0,63}$/;

export interface Worktree {
  path: string;
  branch: string;
  headCommit: string;
}

export async function getOrCreateWorktree(
  repoRoot: string,
  slug: string
): Promise<Worktree> {
  if (!SLUG_RE.test(slug)) throw new Error(`invalid slug: ${slug}`);

  const wtPath = path.join(repoRoot, "..", `pi-wt-${slug}`);
  const branch = `pi/${slug}`;

  // Fast resume
  try {
    const head = (await exec("git", ["-C", wtPath, "rev-parse", "HEAD"])).stdout.trim();
    return { path: wtPath, branch, headCommit: head };
  } catch {
    /* not yet created */
  }

  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/true" };
  await exec("git", ["-C", repoRoot, "fetch", "--quiet"], { env });
  await exec("git", ["-C", repoRoot, "worktree", "add", "-b", branch, wtPath], { env });

  // Symlink heavy dirs
  for (const dir of ["node_modules", ".venv", ".cache", "dist"]) {
    const src = path.join(repoRoot, dir);
    const dst = path.join(wtPath, dir);
    try {
      await fs.access(src);
      await fs.symlink(src, dst, "dir");
    } catch {
      /* missing → skip */
    }
  }

  // Copy non-VCS state files
  for (const f of ["PI.md", ".pi/settings.json", ".env.local"]) {
    const src = path.join(repoRoot, f);
    const dst = path.join(wtPath, f);
    try {
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.copyFile(src, dst);
    } catch {
      /* skip */
    }
  }

  const head = (await exec("git", ["-C", wtPath, "rev-parse", "HEAD"])).stdout.trim();
  return { path: wtPath, branch, headCommit: head };
}

export async function removeWorktree(repoRoot: string, slug: string) {
  if (!SLUG_RE.test(slug)) return;
  const wtPath = path.join(repoRoot, "..", `pi-wt-${slug}`);
  await exec("git", ["-C", repoRoot, "worktree", "remove", "--force", wtPath]).catch(() => {});
}
