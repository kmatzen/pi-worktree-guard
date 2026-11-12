/**
 * worktree-guard — pure decision logic. No pi imports, so it is unit-testable.
 *
 * Goal: a top-level session launched in a repository's PRIMARY checkout must not
 * write into that checkout by default. It creates a worktree and works there.
 * pi has no session cwd setter, so the gate keys on the write TARGET path, not cwd.
 */

import { realpathSync } from "node:fs";
import path from "node:path";

export interface RepoFacts {
	/** Repo root, or null when the cwd is not inside a git work tree. */
	repoRoot: string | null;
	/** True when cwd is the primary checkout, false when it is a linked worktree. */
	mainCheckout: boolean;
}

export const INACTIVE: RepoFacts = { repoRoot: null, mainCheckout: false };

/** git-dir == git-common-dir means primary checkout; differing means a linked worktree. */
export function factsFromGitOutput(showToplevel: string, gitDir: string, commonDir: string): RepoFacts {
	const repoRoot = showToplevel.trim();
	if (!repoRoot) return INACTIVE;
	return { repoRoot, mainCheckout: gitDir.trim() === commonDir.trim() };
}

/** realpath `dir`, walking to the nearest existing ancestor. The dir itself counts. */
export function resolveExistingDir(dir: string): string {
	let cur = dir;
	for (;;) {
		try {
			return realpathSync(cur);
		} catch {
			const parent = path.dirname(cur);
			if (parent === cur) return path.normalize(dir);
			cur = parent;
		}
	}
}

/** Nearest ancestor that exists on disk — a not-yet-created file has no directory of its own. */
export function nearestExistingDir(target: string): string {
	return resolveExistingDir(path.dirname(target));
}

/** Nearest existing ancestor, realpath'd. A file being created has no realpath. */
export function realpathNearest(target: string): string {
	// Git reports --show-toplevel already realpath'd, so a tool path reaching the repo through a
	// symlink (macOS /tmp -> /private/tmp, a symlinked home, a mounted workspace) would otherwise
	// compare as "outside" and bypass the gate.
	let cur = target;
	const tail: string[] = [];
	for (;;) {
		try {
			return path.join(realpathSync(cur), ...tail.reverse());
		} catch {
			const parent = path.dirname(cur);
			if (parent === cur) return path.normalize(target);
			tail.push(path.basename(cur));
			cur = parent;
		}
	}
}

export function isInside(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}

export interface GateInput {
	/** Absolute, normalized write target. */
	targetPath: string;
	facts: RepoFacts;
	enabled: boolean;
	/** Session id; files named after it are session-private. */
	sessionId?: string;
}

export interface GateDecision {
	block: boolean;
	reason?: string;
}

// A file named with THIS session's id (the vault's `pi agent work - <id8>.md`) is private by construction.
export function isSessionNamedFile(targetPath: string, sessionId?: string): boolean {
	const id8 = (sessionId ?? "").slice(0, 8);
	return /^[0-9a-f]{8}/.test(id8) && path.basename(targetPath).includes(id8);
}

/** Only writes landing inside the primary checkout are blocked. */
export function gateDecision({ targetPath, facts, enabled, sessionId }: GateInput): GateDecision {
	if (!enabled || !facts.repoRoot || !facts.mainCheckout) return { block: false };
	if (!isInside(realpathNearest(targetPath), facts.repoRoot)) return { block: false };
	if (isSessionNamedFile(targetPath, sessionId)) return { block: false };
	const repo = path.basename(facts.repoRoot);
	return {
		block: true,
		reason:
			`worktree-guard: blocked write to ${targetPath} — that is the primary checkout of ${repo}, ` +
			`which other sessions and agents share. Create an isolated worktree instead: call the ` +
			`"worktree" tool with a short branch name, then redo this edit using absolute paths under the ` +
			`path it returns. If this checkout really is yours alone, the user can allow writes here for ` +
			`the session with /worktree off`,
	};
}

export function slugify(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "task"
	);
}

export interface WorktreePlan {
	path: string;
	branch: string;
	/** git argv, run with the primary checkout as -C target. */
	gitArgs: string[];
}

/**
 * Why not `HEAD` (do not "simplify" back): it inherits the human's checked-out branch —
 * measured 183 behind main on a merged feature branch — and refs as of the last fetch, 2 days old.
 */
export const DEFAULT_REMOTE = "origin";

export function remoteShowArgs(repoRoot: string, remote: string = DEFAULT_REMOTE): string[] {
	return ["-C", repoRoot, "remote", "show", remote];
}

/** Offline / no remote / unknown HEAD branch returns null (never throws) so the caller degrades. */
export function parseDefaultBranch(remoteShow: string): string | null {
	const m = /^[ \t]*HEAD branch:[ \t]*(.+?)[ \t]*$/m.exec(remoteShow);
	if (!m) return null;
	const branch = m[1].trim();
	return branch && branch !== "(unknown)" ? branch : null;
}

/** Refspec updates the shared tracking ref, so children basing off it start fresher too. */
export function fetchBaseArgs(repoRoot: string, branch: string, remote: string = DEFAULT_REMOTE): string[] {
	return [
		"-C",
		repoRoot,
		"fetch",
		"--no-tags",
		"--quiet",
		remote,
		`+refs/heads/${branch}:refs/remotes/${remote}/${branch}`,
	];
}

export function remoteBranchRef(branch: string, remote: string = DEFAULT_REMOTE): string {
	return `refs/remotes/${remote}/${branch}`;
}

export function verifyRefArgs(repoRoot: string, ref: string): string[] {
	return ["-C", repoRoot, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`];
}

/** `HEAD` goes last so a repo with no remote-tracking ref still gets a worktree, not a failure. */
export function baseRefCandidates(remote: string = DEFAULT_REMOTE): string[] {
	return [
		remoteBranchRef("HEAD", remote),
		remoteBranchRef("main", remote),
		remoteBranchRef("master", remote),
		"refs/heads/main",
		"refs/heads/master",
		"HEAD",
	];
}

/**
 * `<repo parent>/worktrees/<repo>/<slug>` — the same root pi-subagents allocates
 * under, so both isolation systems land in one predictable place.
 */
export function worktreePlan(repoRoot: string, name: string, baseRef: string): WorktreePlan {
	const slug = slugify(name);
	const leaf = path.join(path.dirname(repoRoot), "worktrees", path.basename(repoRoot), slug);
	return {
		path: leaf,
		branch: `wt/${slug}`,
		gitArgs: ["-C", repoRoot, "worktree", "add", "-b", `wt/${slug}`, leaf, baseRef],
	};
}

/** Session-start instruction: the default behavior we want, stated once. */
export function guardInstruction(repoRoot: string): string {
	const repo = path.basename(repoRoot);
	return (
		`worktree-guard: you are in the primary checkout of ${repo} (${repoRoot}). ` +
		`Treat this directory as read-only shared state: do not edit, write, or commit here by default. ` +
		`To start work, call the "worktree" tool with a short kebab-case name for the task; it creates an ` +
		`isolated linked worktree and returns its absolute path. Work in that path — pass absolute paths ` +
		`under it to edit/write, and prefix bash commands with \`cd <worktree> && \`. Reads, greps, and ls in ` +
		`this checkout are fine. Only write here if the user explicitly asks for this checkout, ` +
		`or after they run /worktree off. If the task is a read-only question, answer it — no worktree needed.`
	);
}
