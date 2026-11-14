/**
 * Harness-level tests for the CORE-001 build harness (E2, issue #80):
 *  - the pinned-engine enforcement (verifyEnginePin) fails closed and honours the
 *    UIA_ALLOW_UNPINNED_ENGINE escape hatch;
 *  - the source document identity (docs/CORE-001.md is the canonical, unmodified
 *    CORE-001 Rev 0.3.3 text — sha256 f40876bb..., inherited from CORE-001.legacy.md);
 *  - the artifact rule end-to-end: a stale committed artifact makes `core001:check` fail.
 */
import { execFile as execFileCb, spawnSync } from 'node:child_process';
import { hash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'bun:test';
import { verifyEnginePin } from '../engine-pin.js';
import { ENGINE_ROOT } from './support.js';

const REPO_ROOT = path.resolve(path.dirname(ENGINE_ROOT));

const execFile = (cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<string> =>
  new Promise((resolve, reject) => {
    execFileCb(cmd, args, opts, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });

const runHarness = (env: Record<string, string>, cwd = REPO_ROOT) =>
  spawnSync(process.execPath, ['contracts/core-001/run.ts', '--check'], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });

test('identity: docs/CORE-001.md is the canonical CORE-001 Rev 0.3.3 source', async () => {
  const digest = hash('sha256', await Bun.file(path.join(REPO_ROOT, 'docs', 'CORE-001.md')).bytes());
  // Inherited from CORE-001.legacy.md at the pinned engine commit; E1 records the same
  // digest in the artifact provenance table. If this changes, the contract changed.
  expect(digest).toBe('f40876bb3b3f38c068e4e094a715709836dafc587eae8434ecddba69df981db1');
});

test('pin: a checkout whose HEAD differs from the lock is rejected', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'uia-pin-stale-'));
  await mkdir(path.join(dir, 'spec', 'lib'), { recursive: true });
  await writeFile(path.join(dir, 'spec', 'lib', 'build.ts'), 'export {};\n');
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  await execFile('git', ['init', dir]);
  await execFile('git', ['-C', dir, 'config', 'user.email', 't@example.invalid']);
  await execFile('git', ['-C', dir, 'config', 'user.name', 't']);
  await execFile('git', ['-C', dir, 'add', '-A']);
  await execFile('git', ['-C', dir, 'commit', '-m', 'stale', '--quiet']);
  const head = await execFile('git', ['-C', dir, 'rev-parse', 'HEAD']);

  let message = '';
  try {
    await verifyEnginePin(dir, { commit: '0'.repeat(64), version: '0.1.0' });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain('does not match engine.lock.json');
  expect(message).toContain(`HEAD is ${head.slice(0, 7)}`);
});

test('pin: a version mismatch is rejected even at the pinned commit', async () => {
  const head = await execFile('git', ['-C', ENGINE_ROOT, 'rev-parse', 'HEAD']);
  let message = '';
  try {
    await verifyEnginePin(ENGINE_ROOT, { commit: head, version: '9.9.9' });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain('package version');
});

test('pin: UIA_ALLOW_UNPINNED_ENGINE=1 downgrades the mismatch to a warning', async () => {
  const previous = process.env.UIA_ALLOW_UNPINNED_ENGINE;
  process.env.UIA_ALLOW_UNPINNED_ENGINE = '1';
  try {
    // Must resolve without throwing even though the "lock" below matches nothing real.
    await verifyEnginePin(ENGINE_ROOT, { commit: '0'.repeat(64), version: '9.9.9' });
  } finally {
    if (previous === undefined) delete process.env.UIA_ALLOW_UNPINNED_ENGINE;
    else process.env.UIA_ALLOW_UNPINNED_ENGINE = previous;
  }
});

test('artifact rule: run.ts --check fails closed on a stale UIA_ENGINE_ROOT', async () => {
  // A checkout that looks valid (build lib present, matching version) but whose HEAD is
  // not the pinned commit must abort the check, not silently produce a "matching" result.
  const dir = await mkdtemp(path.join(tmpdir(), 'uia-pin-stale-e2e-'));
  await mkdir(path.join(dir, 'spec', 'lib'), { recursive: true });
  await writeFile(path.join(dir, 'spec', 'lib', 'build.ts'), 'export {};\n');
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  await execFile('git', ['init', dir]);
  await execFile('git', ['-C', dir, 'config', 'user.email', 't@example.invalid']);
  await execFile('git', ['-C', dir, 'config', 'user.name', 't']);
  await execFile('git', ['-C', dir, 'add', '-A']);
  await execFile('git', ['-C', dir, 'commit', '-m', 'stale', '--quiet']);

  const result = runHarness({ UIA_ENGINE_ROOT: dir });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('does not match engine.lock.json');
});

test('artifact rule: the committed artifact hash matches the recorded golden', async () => {
  const artifact = await Bun.file(path.join(REPO_ROOT, 'contracts', 'core-001', 'output', 'CORE-001.draft.md')).text();
  const golden = await Bun.file(
    path.join(REPO_ROOT, 'contracts', 'core-001', 'tests', 'golden', 'core001.draft.sha256'),
  ).text();
  const recorded = golden.trim().split(/\s+/)[0];
  expect(hash('sha256', Buffer.from(artifact, 'utf8'))).toBe(recorded);
});

test('the engine checkout is materialized at <repoRoot>/contract-builder for tests', async () => {
  // The moved suite statically imports engine modules through this path; this test turns
  // a missing materialization into an explicit, readable failure instead of a module error.
  expect(await Bun.file(path.join(ENGINE_ROOT, 'spec', 'lib', 'build.ts')).exists()).toBeTrue();
});
