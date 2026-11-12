# pi-worktree-guard

**Agents writing into a repository's primary checkout is not a hypothetical. Measured on one
repository: 24 of 29 sessions overlapped in time, all editing the same checkout, and the wreckage
was twelve orphaned index entries nobody could attribute to anything.**

The natural defense — "agents should use worktrees" — has a hole you can drive through: a session
launched in the primary checkout writes straight into it, because nothing is watching. Pi core is
aware of worktrees but read-only about them; the subagent systems isolate their *children* and
leave top-level sessions free; pi has no session working-directory setter. The convention exists.
The gate does not.

pi-worktree-guard is the gate. At session start it nudges: this session is in a primary checkout,
isolate before writing. Then it does the part conventions cannot do — it **hard-blocks `edit` and
`write` whose resolved target lands in a primary checkout**, with a block message that says what
to do instead: create a worktree with the `worktree` tool and work through absolute paths under
it.

## The detail that makes it real

The gate resolves the **repository of the write target**, not of the session's working directory.
That distinction is the whole design. A session opened in a monorepo parent, a workspace root, or
any non-repo directory gets no free pass to write into a checkout *below* it: the path you are
writing into decides the answer, and a path inside a primary checkout is a block, wherever you
were sitting when you chose it.

Reads, greps and searches in the primary checkout are untouched — the guard exists to stop
mutations of shared state, not to sandbox curiosity. Pure questions, answered in place, are never
blocked. And the escape hatch is explicit and human-owned: the operator can allow writes to a
checkout for a session (`/worktree off`); an agent cannot talk itself into it.

## What it changes for an agent

Before: an agent in a clone edits files in place, colliding with every other session in the same
tree, and attribution dies at the index. After: the first write fails with instructions, the
agent calls the `worktree` tool, gets an isolated checkout branched from the fetched default, and
continues there. The collision never reaches disk.

## Install

```bash
pi install npm:pi-worktree-guard
```

TypeScript source loaded by pi directly; `@earendil-works/pi-coding-agent` is a peer dependency
and never bundled.

## License

MIT
