# CORE-001 contract project

Consumer-owned CORE-001 contract project (extraction E1, agent-federation/uia#79).
`docs/CORE-001.md` is the canonical source; the `core001` profile is owned here, the
build engine lives in [`agent-federation/contract-builder`](https://github.com/agent-federation/contract-builder)
and is pinned by [`engine.lock.json`](./engine.lock.json).

## Local setup

The engine checkout is **not committed** (see the repo `.gitignore`). Materialize the
exact pinned commit once per machine:

```bash
repo="$(jq -r .repository contracts/core-001/engine.lock.json)"
commit="$(jq -r .commit contracts/core-001/engine.lock.json)"

# Preferred location (also picked up by the ../contract-builder candidate):
git clone "https://github.com/${repo}" ../contract-builder
git -C ../contract-builder checkout "${commit}"
(cd ../contract-builder && bun install --frozen-lockfile)
```

Or clone anywhere and point the harness at it: `export UIA_ENGINE_ROOT=/path/to/contract-builder`.

## Commands

```bash
bun run check:core001:sync   # pin check + profile deps <-> package.json <-> engine bun.lock
bun run core001:check        # build with the pinned engine; committed artifact must match byte-for-byte
bun run core001:build        # rebuild contracts/core-001/output/CORE-001.draft.md and commit it
```

`core001:check` / `core001:build` fail closed unless the resolved engine checkout's git
HEAD and package version match `engine.lock.json`. For unpinned development (rare) set
`UIA_ALLOW_UNPINNED_ENGINE=1` — mismatches are then warnings, and the artifact output
must not be committed.

## Tests

The CORE-001 project suite (moved from `contract-builder` in E2, issue #80) lives in
`tests/` and runs as part of `bun test`. It needs the materialized engine checkout plus a
root `spec -> contract-builder/spec` symlink, because the tests import profile modules
directly and bun resolves their authored `../../spec/lib/...` engine imports from the repo
root (tsc uses the `rootDirs` bridge instead):

```bash
ln -s contract-builder/spec spec
bun test contracts/core-001/tests
```

`tests/golden/core001.draft.sha256` records the committed artifact's hash — the artifact
rule in CI (and the golden test) fails on any stale or hand-edited artifact.

## Invariants

- **D7 byte identity**: the committed `output/CORE-001.draft.md` differs from the
  pinned engine's build only in the source filename and `inputDigest` lines. The file is
  excluded from Prettier; never hand-edit it — rerun `core001:build`.
- **Engine imports**: profile sources keep their authored `../../spec/lib/...` imports;
  TypeScript resolves them through the `rootDirs` bridge to `contract-builder`
  (`tsconfig.json`), and the engine's import mapping resolves them to the engine root at
  runtime.
- **`inputDigest`** covers the declared inputs, including profile sources: any edit under
  `profiles/core001` changes the digest, so rerun `core001:build` and commit the artifact.
- CI (`.github/workflows/ci.yml`) materializes the pinned engine and runs all of the
  above, including the byte-identity check.
