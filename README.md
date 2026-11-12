# pi-worktree-guard

**Agents writing into a repository's primary checkout is not a hypothetical. On one repository I
measured it directly: twenty-nine sessions, twenty-four of them overlapping in time, all editing
the same checkout at once. What they left behind was twelve orphaned index entries that nobody
could attribute to anything.**

The usual answer is a convention: agents should work in worktrees. Conventions have a hole you can
drive through. A session launched in the primary checkout writes straight into it, because nothing
is watching. Pi's core is aware of worktrees but never enforces them; the subagent systems isolate
their children and leave top-level sessions free to roam; pi has no way to set a session's working
directory. The convention exists. The gate does not.

pi-worktree-guard is the gate. At session start it nudges: this session is sitting in a primary
checkout, isolate before you write. Then it does the part a convention cannot do, and hard-blocks
any `edit` or `write` whose resolved target lands in a primary checkout. The block message says
what to do instead: create a worktree with the `worktree` tool, and work through absolute paths
inside it.

## The detail that makes it real

The gate resolves the repository of the **path being written**, not of the session's working
directory. That distinction is the whole design. A session opened in a monorepo parent, a workspace
root, or any directory that is not itself a repository gets no free pass to write into a checkout
below it. The path you are writing into decides the answer, and a path inside a primary checkout is
a block, no matter where you were sitting when you chose it.

Reading is never the problem. Reads, greps, and searches in the primary checkout pass untouched,
because the guard exists to stop mutations of shared state, not to sandbox curiosity, and a
question answered in place is never blocked. When writes to a checkout really are intended, the
escape hatch is explicit and human-owned: the operator can allow writes for a session
(`/worktree off`). An agent cannot talk itself through that door.

## What changes for an agent

Before: an agent in a clone edits files in place, colliding with every other session in the same
tree, and attribution dies somewhere in the index. After: the first write fails with instructions,
the agent calls the `worktree` tool, receives an isolated checkout branched from the fetched
default branch, and continues there. The collision never reaches disk.

## Install

```bash
pi install npm:pi-worktree-guard
```

TypeScript source, loaded directly by pi. It declares `@earendil-works/pi-coding-agent` as a peer
dependency and bundles nothing.

## License

MIT
