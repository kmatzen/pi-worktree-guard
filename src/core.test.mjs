import { parseDefaultBranch, baseRefCandidates, fetchBaseArgs, remoteBranchRef, worktreePlan, verifyRefArgs, gateDecision } from "/home/dev/.pi/agent/extensions/worktree-guard/core.ts";
let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
};

eq("default branch parsed", parseDefaultBranch("* remote origin\n  HEAD branch: main\n  Remote branches:\n"), "main");
eq("non-main default", parseDefaultBranch("  HEAD branch: develop\n"), "develop");
eq("offline -> null", parseDefaultBranch("fatal: 'origin' does not appear to be a git repository"), null);
eq("unknown -> null", parseDefaultBranch("  HEAD branch: (unknown)\n"), null);
eq("empty -> null", parseDefaultBranch(""), null);
eq("whitespace-only -> null", parseDefaultBranch("  HEAD branch: \n"), null);

eq("HEAD is last fallback", baseRefCandidates().at(-1), "HEAD");
eq("mirror before local", baseRefCandidates().slice(0, 3), ["refs/remotes/origin/HEAD", "refs/remotes/origin/main", "refs/remotes/origin/master"]);

eq("fetch updates tracking ref", fetchBaseArgs("/repo", "main"),
   ["-C", "/repo", "fetch", "--no-tags", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
eq("worktree branches from given ref", worktreePlan("/repo", "my-task", "refs/remotes/origin/main").gitArgs,
   ["-C", "/repo", "worktree", "add", "-b", "wt/my-task", "/worktrees/repo/my-task", "refs/remotes/origin/main"]);
eq("HEAD opt-in still expressible", worktreePlan("/repo", "x", "HEAD").gitArgs.at(-1), "HEAD");
eq("ref verified as commit", verifyRefArgs("/r", "refs/heads/main").at(-1), "refs/heads/main^{commit}");
eq("remoteBranchRef", remoteBranchRef("main"), "refs/remotes/origin/main");

const VAULT = { repoRoot: "/home/dev/notes", mainCheckout: true };
const SID = "01a18a85-7501-73b6-9a24-c8a77e6feb9d";
const gate = (file, facts = VAULT, sessionId = SID) =>
  gateDecision({ targetPath: `/home/dev/notes/${file}`, facts, enabled: true, sessionId }).block;

eq("shared file in primary checkout blocks", gate("pi fleet notes.md"), true);
eq("own session doc passes", gate("pi agent work - 01a18a85.md"), false);
eq("another session's doc blocks", gate("pi agent work - 01a1418e.md"), true);
eq("missing session id blocks own doc", gateDecision({ targetPath: "/home/dev/notes/pi agent work - 01a18a85.md", facts: VAULT, enabled: true }).block, true);
eq("empty session id blocks", gate("pi agent work - 01a18a85.md", VAULT, ""), true);
eq("id8 inside an unrelated name passes", gate("notes-01a18a85-tmp.md"), false);
eq("linked worktree never blocks", gate("pi fleet notes.md", { repoRoot: "/home/dev/notes", mainCheckout: false }), false);

console.log(fail ? `\n${fail} FAILURE(S)` : "\nall pure-logic assertions pass");
process.exit(fail ? 1 : 0);
