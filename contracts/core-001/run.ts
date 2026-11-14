/**
 * CORE-001 project build harness (extraction E1, agent-federation/uia#79).
 *
 * Builds `output/CORE-001.draft.md` with the pinned contract-builder engine checkout
 * (`engine.lock.json`, resolved as a directory that contains `spec/lib/build.js`). The build runs
 * in a temporary workspace that mirrors the repository layout so every declared path in
 * `contract-builder.json` stays byte-identical to the authored one; only file copies move. That
 * keeps `inputDigest` semantics unchanged: the digest covers input bytes, not their location.
 *
 * Usage:
 *   bun contracts/core-001/run.ts            # build in a temp workspace, compare the committed artifact
 *   bun contracts/core-001/run.ts --write    # refresh the committed artifact from the temp build
 *   bun contracts/core-001/run.ts --check    # same as the default comparison mode
 */
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// Type-only views of the pinned engine's API. Resolved at typecheck time through the
// materialized engine checkout (see rootDirs / .gitignore); at runtime the modules are
// imported from the resolved engine root below.
import type * as engineBuild from '../../contract-builder/spec/lib/build.js';
import type * as engineRenderers from '../../contract-builder/spec/cli-renderers.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

interface EngineLock {
  schema: string;
  repository: string;
  commit: string;
  version: string;
  checkout: string;
}

const COMMITTED_ARTIFACT = path.join(HERE, 'output', 'CORE-001.draft.md');
const PROJECT_FILES = [
  'contract-builder.json',
  'sources.yml',
  'ontology.yml',
  'semantics.json',
  'decisions.yml',
  'conformance/cases.yml',
] as const;

async function loadEngineLock(): Promise<EngineLock> {
  const raw = await readFile(path.join(HERE, 'engine.lock.json'), 'utf8');
  return JSON.parse(raw) as EngineLock;
}

async function resolveEngineRoot(lock: EngineLock): Promise<string> {
  const candidates = [
    process.env.UIA_ENGINE_ROOT ?? '',
    path.resolve(HERE, lock.checkout),
    path.resolve(REPO_ROOT, '..', 'contract-builder'),
  ].filter((candidate) => candidate.length > 0);
  for (const candidate of candidates) {
    // Accept both a source (build.ts) and a compiled (build.js) engine checkout; the
    // runtime imports spec/lib/build.js either way (Bun maps .js -> .ts for source trees).
    const exists = async (rel: string[]): Promise<boolean> => {
      try {
        await readFile(path.join(candidate, ...rel));
        return true;
      } catch {
        return false;
      }
    };
    if ((await exists(['spec', 'lib', 'build.ts'])) || (await exists(['spec', 'lib', 'build.js']))) {
      await verifyEnginePin(candidate, lock);
      return candidate;
    }
  }
  throw new Error(
    `Engine checkout not found for ${lock.repository}@${lock.commit.slice(0, 7)}. ` +
      `Clone it to "${path.join(REPO_ROOT, 'contract-builder')}" and materialize the pinned ` +
      `commit (see contracts/core-001/README.md), or set UIA_ENGINE_ROOT. ` +
      `Checked: ${candidates.join(', ')}`,
  );
}

/**
 * Fails closed unless the resolved checkout is exactly the pinned engine: its git HEAD must
 * equal engine.lock.json.commit and its package version must equal engine.lock.json.version.
 * Set UIA_ALLOW_UNPINNED_ENGINE=1 to develop against a different checkout; the mismatch is
 * then reported as a warning instead of an error.
 */
async function verifyEnginePin(candidate: string, lock: EngineLock): Promise<void> {
  const problems: string[] = [];

  const { execFile } = await import('node:child_process');
  const gitHead = await new Promise<string>((resolve) => {
    execFile('git', ['-C', candidate, 'rev-parse', 'HEAD'], (error, stdout) => {
      resolve(error ? '' : stdout.trim());
    });
  });
  if (gitHead === '') {
    problems.push('not a git checkout (cannot read HEAD)');
  } else if (gitHead !== lock.commit) {
    problems.push(
      `HEAD is ${gitHead.slice(0, 7)}, lock pins ${lock.commit.slice(0, 7)}` +
        ` — run "git -C ${candidate} fetch && git -C ${candidate} checkout ${lock.commit}"`,
    );
  }

  try {
    const pkg = JSON.parse(await readFile(path.join(candidate, 'package.json'), 'utf8')) as {
      version?: string;
    };
    if (pkg.version !== lock.version) {
      problems.push(`package version is ${pkg.version ?? 'unknown'}, lock pins ${lock.version}`);
    }
  } catch {
    problems.push('package.json is unreadable');
  }

  if (problems.length === 0) return;
  const message =
    `Engine checkout at ${candidate} does not match engine.lock.json:\n` +
    problems.map((problem) => `  - ${problem}`).join('\n');
  if (process.env.UIA_ALLOW_UNPINNED_ENGINE === '1') {
    console.error(`WARNING (UIA_ALLOW_UNPINNED_ENGINE=1): ${message}`);
    return;
  }
  throw new Error(
    `${message}\nMaterialize the pinned commit (contracts/core-001/README.md) or set ` +
      `UIA_ALLOW_UNPINNED_ENGINE=1 for unpinned development.`,
  );
}

/**
 * Copies the project into a temp workspace that mirrors the repository layout:
 * `<root>/contracts/core-001`, `<root>/profiles/core001`, `<root>/docs/CORE-001.md`. The
 * authored relative manifest paths (`../../profiles/core001`, `../../docs/CORE-001.md`) stay
 * valid, and engine-owned profile imports resolve from the explicit engine root.
 */
async function prepareWorkspace(engineRoot: string): Promise<{ root: string; projectDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'uia-core001-'));
  const projectDir = path.join(root, 'contracts', 'core-001');
  await mkdir(projectDir, { recursive: true });
  for (const file of PROJECT_FILES) {
    await cp(path.join(HERE, file), path.join(projectDir, file));
  }
  await cp(path.join(REPO_ROOT, 'profiles', 'core001'), path.join(root, 'profiles', 'core001'), {
    recursive: true,
  });
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await cp(path.join(REPO_ROOT, 'docs', 'CORE-001.md'), path.join(root, 'docs', 'CORE-001.md'));
  // The engine reads its own bun.lock (engineRoot/bun.lock) for the profile closure preflight,
  // never the consumer's. Mirror the real dependency tree instead of copying a lockfile whose
  // integrity entries would not match this machine's node_modules. A symlink is instantaneous
  // and shares the tree; fall back to a recursive copy only if symlinking fails (e.g. on a
  // platform or filesystem that refuses directory symlinks).
  const engineNodeModules = path.join(engineRoot, 'node_modules');
  const workspaceNodeModules = path.join(root, 'node_modules');
  try {
    await symlink(engineNodeModules, workspaceNodeModules, 'dir');
  } catch {
    await cp(engineNodeModules, workspaceNodeModules, { recursive: true });
  }
  return { root, projectDir };
}

async function main(argv: string[]): Promise<number> {
  const write = argv.includes('--write');
  if (argv.some((arg) => !['--write', '--check'].includes(arg))) {
    console.error('Usage: bun contracts/core-001/run.ts [--write|--check]');
    return 1;
  }
  const lock = await loadEngineLock();
  const engineRoot = await resolveEngineRoot(lock);

  const { runBuild } = (await import(pathToFileURL(path.join(engineRoot, 'spec', 'lib', 'build.js')).href)) as {
    runBuild: typeof engineBuild.runBuild;
  };
  const { loadProfileRenderers } = (await import(
    pathToFileURL(path.join(engineRoot, 'spec', 'cli-renderers.js')).href
  )) as { loadProfileRenderers: typeof engineRenderers.loadProfileRenderers };

  const rendererModule = path.join(REPO_ROOT, 'profiles', 'core001', 'renderer.ts');
  const renderers = await loadProfileRenderers(true, HERE, {
    rendererModule,
    engineRoot,
  });
  if (Object.keys(renderers).length === 0) {
    console.error(
      `Renderer loading failed for ${rendererModule}; check the engine pin (${lock.commit}) and the profile closure.`,
    );
    return 1;
  }

  const { root, projectDir } = await prepareWorkspace(engineRoot);
  try {
    const result = await runBuild({
      specDir: projectDir,
      mode: 'draft',
      write: true,
      check: false,
      strict: false,
      renderers,
      allowExecutableProfile: true,
      engineRoot,
    });
    for (const diagnostic of result.diagnostics) {
      console.error(`[${diagnostic.severity}] ${diagnostic.code}`);
    }
    if (result.exitCode !== 0 || result.blockedBy !== null) {
      console.error(`Build blocked (exit ${result.exitCode}, blockedBy=${result.blockedBy ?? 'null'})`);
      return 1;
    }

    const generatedPath = path.join(projectDir, 'output', 'CORE-001.draft.md');
    const generated = await readFile(generatedPath);
    if (write) {
      await mkdir(path.dirname(COMMITTED_ARTIFACT), { recursive: true });
      await writeFile(COMMITTED_ARTIFACT, generated);
      console.log(`Updated ${path.relative(REPO_ROOT, COMMITTED_ARTIFACT)}`);
      return 0;
    }

    let committed: Uint8Array;
    try {
      committed = await readFile(COMMITTED_ARTIFACT);
    } catch {
      console.error(
        `Committed artifact missing: ${path.relative(REPO_ROOT, COMMITTED_ARTIFACT)}. ` +
          `Run "bun run core001:build" and commit it.`,
      );
      return 1;
    }
    if (Buffer.compare(Buffer.from(committed), Buffer.from(generated)) === 0) {
      console.log(
        `OK: ${path.relative(REPO_ROOT, COMMITTED_ARTIFACT)} matches the pinned-engine build ` +
          `(${lock.repository}@${lock.commit.slice(0, 7)}, version ${lock.version})`,
      );
      return 0;
    }
    console.error(
      `MISMATCH: ${path.relative(REPO_ROOT, COMMITTED_ARTIFACT)} differs from the pinned-engine build. ` +
        `Run "bun run core001:build" and review the diff.`,
    );
    return 1;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

process.exitCode = await main(process.argv.slice(2));
