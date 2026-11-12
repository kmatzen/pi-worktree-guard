/**
 * worktree-guard — make worktree isolation the default for a top-level session.
 *
 * Why: a session launched in a repository's primary checkout used to write straight into
 * it. Measured on one repo: 24 of 29 sessions overlapped in time, all in the same
 * checkout, ending in 12 orphaned unmerged index entries. Nothing gated it — pi core is
 * read-only aware of worktrees, pi-subagents/dynamic-workflows isolate only their
 * CHILDREN, and pi has no session cwd setter.
 *
 * So: nudge at session start, then hard-block edit/write whose resolved TARGET lands in
 * a primary checkout. The gate resolves the repo of the WRITE TARGET, not of the session
 * cwd — a session opened in a non-repo directory (a monorepo parent, a workspace root)
 * must not get a free pass to write into a checkout below it. The agent creates a
 * worktree with the `worktree` tool and works there via absolute paths.
 * bash is not gated (false-positive risk); reads are never gated.
 *
 * Off switches: `/worktree off` for this session, `{"enabled": false}` in
 * worktree-guard.json next to this file (reload after editing).
 *
 * shortcut: gates edit/write only — a `bash` redirect, `sed -i`, or `git commit` inside a
 * primary checkout still passes. Upgrade to a mutating-bash pattern list if that bites.
 */

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	factsFromGitOutput,
	gateDecision,
	guardInstruction,
	nearestExistingDir,
	resolveExistingDir,
	worktreePlan,
	baseRefCandidates,
	DEFAULT_REMOTE,
	fetchBaseArgs,
	parseDefaultBranch,
	remoteBranchRef,
	remoteShowArgs,
	verifyRefArgs,
	INACTIVE,
	type RepoFacts,
} from "./core.ts";

function loadEnabled(): boolean {
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		const cfg = JSON.parse(readFileSync(new URL("./worktree-guard.json", `file://${here}/`), "utf8"));
		return cfg?.enabled !== false;
	} catch {
		return true; // no config -> on
	}
}

export default function (pi: ExtensionAPI) {
	let enabled = loadEnabled();
	let optedOut = false;
	let nudged = false;
	let sessionFacts: RepoFacts = INACTIVE;
	const factsCache = new Map<string, Promise<RepoFacts>>();

	const git = async (ctx: ExtensionContext, args: string[]) => {
		const { stdout, code } = await pi.exec("git", args, { cwd: ctx.cwd, signal: ctx.signal });
		return { out: stdout.trim(), ok: code === 0 };
	};

	/** Timeout is the only hang guard: pi.exec takes no env, so GIT_TERMINAL_PROMPT=0 is unavailable. */
	const gitNet = async (ctx: ExtensionContext, args: string[]) => {
		const { stdout, code } = await pi.exec("git", args, { cwd: ctx.cwd, signal: ctx.signal, timeout: 20_000 });
		return { out: stdout.trim(), ok: code === 0 };
	};

	/**
	 * Never throws: offline / no-remote / credential-prompt degrades to a known local ref.
	 * `note` names the base actually chosen, so the agent is never misled about what it branched from.
	 */
	async function resolveBase(
		ctx: ExtensionContext,
		repoRoot: string,
		requested?: string,
	): Promise<{ ref: string; note: string }> {
		if (requested && requested.trim()) return { ref: requested.trim(), note: `explicit baseRef` };
		const show = await gitNet(ctx, remoteShowArgs(repoRoot));
		const branch = show.ok ? parseDefaultBranch(show.out) : null;
		if (branch) {
			const ref = remoteBranchRef(branch);
			if ((await gitNet(ctx, fetchBaseArgs(repoRoot, branch))).ok) {
				return { ref, note: `current ${DEFAULT_REMOTE}/${branch}, just fetched` };
			}
			if ((await git(ctx, verifyRefArgs(repoRoot, ref))).ok) {
				return { ref, note: `${DEFAULT_REMOTE}/${branch} as of the last fetch — fetch failed, base may be stale` };
			}
		}
		for (const cand of baseRefCandidates()) {
			if ((await git(ctx, verifyRefArgs(repoRoot, cand))).ok) {
				return cand === "HEAD"
					? { ref: "HEAD", note: "current HEAD — no default-branch ref found, base may be off main" }
					: { ref: cand, note: `${cand} — default branch unresolvable` };
			}
		}
		return { ref: "HEAD", note: "current HEAD — no resolvable ref" };
	}

	/** Repo facts for a directory: primary checkout, repo root and all; INACTIVE when not a repo. */
	async function detectAt(ctx: ExtensionContext, dir: string): Promise<RepoFacts> {
		const top = await git(ctx, ["-C", dir, "rev-parse", "--show-toplevel"]);
		if (!top.ok || !top.out) return INACTIVE;
		const gitDir = await git(ctx, ["-C", dir, "rev-parse", "--git-dir"]);
		const commonDir = await git(ctx, ["-C", dir, "rev-parse", "--git-common-dir"]);
		if (!gitDir.ok || !commonDir.ok) return INACTIVE;
		return factsFromGitOutput(top.out, gitDir.out, commonDir.out);
	}

	function factsFor(ctx: ExtensionContext, dir: string): Promise<RepoFacts> {
		const hit = factsCache.get(dir);
		if (hit) return hit;
		const pending = detectAt(ctx, dir);
		factsCache.set(dir, pending);
		return pending;
	}

	/** Facts governing a write target: the repo that owns it, resolved from its own directory. */
	function factsForTarget(ctx: ExtensionContext, absTarget: string): Promise<RepoFacts> {
		return factsFor(ctx, nearestExistingDir(absTarget));
	}

	async function create(
		ctx: ExtensionContext,
		name: string,
		inside?: string,
		requestedBase?: string,
	): Promise<{ path: string; branch: string; baseRef: string; baseNote: string } | string> {
		const base = inside && inside.trim() ? path.resolve(inside) : ctx.cwd;
		const facts = await factsFor(ctx, resolveExistingDir(base));
		if (!facts.repoRoot) return `no git repository at or above ${base}, so there is nothing to isolate`;
		const sel = await resolveBase(ctx, facts.repoRoot, requestedBase);
		const plan = worktreePlan(facts.repoRoot, name, sel.ref);
		const { out, ok } = await git(ctx, plan.gitArgs);
		if (!ok) return `git worktree add failed: ${out.slice(0, 400) || "unknown git error"}`;
		return { path: plan.path, branch: plan.branch, baseRef: sel.ref, baseNote: sel.note };
	}

	const usage = "usage: /worktree <name>   |   /worktree off   |   /worktree on   |   /worktree status";

	pi.registerTool(
		defineTool({
			name: "worktree",
			label: "Worktree",
			description:
			"Create an isolated git worktree for this task, based on the repo's default branch at its " +
			"fetched tip (not the checked-out HEAD), and return its absolute path. Work in that path; do " +
			"not edit a primary checkout.",
			parameters: Type.Object({
				name: Type.String({ description: "Short kebab-case task name, e.g. fix-login-redirects" }),
				path: Type.Optional(
					Type.String({ description: "Path inside the repo to isolate; defaults to the session cwd" }),
				),
				baseRef: Type.Optional(
					Type.String({
						description:
							"Override the base. Default: the remote's default branch, fetched. " +
							"Pass 'HEAD' to stack on the currently checked-out branch.",
					}),
				),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				const result = await create(ctx, params.name, params.path, params.baseRef);
				if (typeof result === "string") {
					return { content: [{ type: "text", text: result }], details: undefined, isError: true };
				}
				return {
					content: [
						{
							type: "text",
							text:
								`Worktree ready: ${result.path}\nbranch: ${result.branch}\nbase: ${result.baseRef} — ${result.baseNote}\n` +
								`Work there: pass absolute paths under ${result.path} to edit/write, ` +
								`and prefix bash with \`cd ${result.path} && \`.`,
						},
					],
					details: { path: result.path, branch: result.branch, baseRef: result.baseRef },
				};
			},
		}),
	);

	pi.registerCommand("worktree", {
		description: "Isolate this session in a new git worktree (off/on/status)",
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === "off") {
				optedOut = true;
				ctx.ui.notify("worktree-guard off for this session — writes to primary checkouts allowed", "warning");
				return;
			}
			if (arg === "on") {
				optedOut = false;
				nudged = false;
				ctx.ui.notify("worktree-guard on for this session", "info");
				return;
			}
			if (arg === "status" || arg === "") {
				sessionFacts = await factsFor(ctx, ctx.cwd);
				const state = !sessionFacts.repoRoot
					? `armed for any repo you write into (session cwd ${ctx.cwd} is not a git repo)`
					: !sessionFacts.mainCheckout
						? `inactive (already in a linked worktree: ${sessionFacts.repoRoot})`
						: optedOut || !enabled
							? `idle (writes to ${sessionFacts.repoRoot} are allowed)`
							: `armed (writes to ${sessionFacts.repoRoot} are blocked)`;
				ctx.ui.notify(`worktree-guard: ${state}`, "info");
				if (arg === "") ctx.ui.notify(usage, "info");
				return;
			}
			const result = await create(ctx, arg);
			if (typeof result === "string") ctx.ui.notify(result, "error");
			else ctx.ui.notify(`worktree ready: ${result.path} (${result.branch}) on ${result.baseRef}`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		optedOut = false;
		nudged = false;
		factsCache.clear();
		enabled = loadEnabled();
		sessionFacts = await factsFor(ctx, ctx.cwd);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!enabled || optedOut || nudged) return;
		if (event.messageType !== "user") return;
		factsCache.clear(); // cwd and repo state can move between runs
		sessionFacts = await factsFor(ctx, ctx.cwd);
		if (!sessionFacts.repoRoot || !sessionFacts.mainCheckout) return;
		nudged = true;
		return {
			message: { customType: "worktree-guard", content: guardInstruction(sessionFacts.repoRoot), display: true },
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!enabled || optedOut) return;
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		const target = (event.input as { path?: unknown } | undefined)?.path;
		if (typeof target !== "string" || target === "") return;
		const abs = path.isAbsolute(target) ? path.normalize(target) : path.resolve(ctx.cwd, target);
		const decision = gateDecision({
			targetPath: abs,
			facts: await factsForTarget(ctx, abs),
			enabled,
			sessionId: ctx.sessionManager.getSessionId(),
		});
		// No `terminate`: the point is for the model to read the reason and recover by calling
		// the worktree tool. Terminating the batch ends the turn and surfaces nothing to adapt to.
		if (decision.block) return { block: true, reason: decision.reason };
	});
}
