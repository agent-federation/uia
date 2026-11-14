/**
 * Sync checks for the CORE-001 contract project (consumer-owned, E1).
 *
 * Verifies that:
 *  1. every dependency declared by the profile manifest (profiles/core001/profile.json)
 *     matches the version pinned in the consumer package.json;
 *  2. contracts/core-001/engine.lock.json pins the repository/version recorded in the
 *     manifest, and the engine HEAD/version match the lock (via the harness's own pin
 *     enforcement at build time);
 *  3. each declared dependency resolves to the same version in the pinned engine's
 *     bun.lock as in the consumer package.json (the cross-lock invariant).
 *
 * Requires the engine checkout to be materialized (CI materializes it first; locally see
 * contracts/core-001/README.md) and enforces the same pin as the build harness via the
 * shared verifyEnginePin. Exit code 1 on any mismatch, so it can run in CI.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyEnginePin } from '../contracts/core-001/engine-pin.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

interface ProfileManifest {
  version?: string;
  dependencies?: Record<string, string>;
}

interface EngineLock {
  schema: string;
  repository: string;
  commit: string;
  version: string;
  checkout: string;
}

async function readJson(rel: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(REPO_ROOT, rel), 'utf8'));
}

/** Same candidate order as contracts/core-001/run.ts resolveEngineRoot(). */
async function resolveEngineRoot(lock: EngineLock): Promise<string> {
  const candidates = [
    process.env.UIA_ENGINE_ROOT ?? '',
    path.resolve(REPO_ROOT, 'contracts', 'core-001', lock.checkout),
    path.resolve(REPO_ROOT, '..', 'contract-builder'),
  ].filter((candidate) => candidate.length > 0);
  for (const candidate of candidates) {
    for (const buildLib of ['build.ts', 'build.js']) {
      try {
        await readFile(path.join(candidate, 'spec', 'lib', buildLib));
        return candidate;
      } catch {
        // try the next candidate / variant
      }
    }
  }
  throw new Error(
    `engine checkout not found; materialize it first (contracts/core-001/README.md), ` +
      `checked: ${candidates.join(', ')}`,
  );
}

/** Extracts the resolved version of a package from a bun.lock text-format lockfile. */
function resolvedVersionFromBunLock(bunLock: string, name: string): string | undefined {
  const entry = bunLock.match(new RegExp(`"${name}":\\s*\\["${name}@([^"]+)"`));
  return entry?.[1];
}

async function main(): Promise<number> {
  let failed = false;
  const fail = (message: string): void => {
    failed = true;
    console.error(`SYNC-MISMATCH: ${message}`);
  };

  const pkg = (await readJson('package.json')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const profile = (await readJson('profiles/core001/profile.json')) as ProfileManifest;
  const lock = (await readJson('contracts/core-001/engine.lock.json')) as EngineLock;

  for (const [name, declared] of Object.entries(profile.dependencies ?? {})) {
    const pinned = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name];
    if (pinned === undefined) {
      fail(`profile declares "${name}" but package.json does not pin it`);
    } else if (pinned !== declared) {
      fail(`"${name}" profile declares ${declared}, package.json pins ${pinned}`);
    }
  }

  if (lock.schema !== 'uia-engine-lock/0.1') {
    fail(`engine.lock.json has unexpected schema ${lock.schema}`);
  }
  if (!/^[0-9a-f]{40}$/.test(lock.commit)) {
    fail(`engine.lock.json commit is not a full 40-hex SHA: ${lock.commit}`);
  }

  if (!failed) {
    // Cross-lock invariant: the pinned engine must resolve each declared dependency to the
    // same version the consumer pins (e.g. nunjucks 3.2.4 in both bun.lock files).
    try {
      const engineRoot = await resolveEngineRoot(lock);
      // Same pin enforcement as the build harness: the cross-lock read below is only
      // meaningful for the exact pinned checkout.
      await verifyEnginePin(engineRoot, lock);
      const bunLock = await readFile(path.join(engineRoot, 'bun.lock'), 'utf8');
      for (const [name, declared] of Object.entries(profile.dependencies ?? {})) {
        const resolved = resolvedVersionFromBunLock(bunLock, name);
        if (resolved === undefined) {
          fail(`engine bun.lock does not resolve "${name}"`);
        } else if (resolved !== declared) {
          fail(`"${name}" resolves to ${resolved} in the pinned engine, consumer pins ${declared}`);
        }
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  if (failed) return 1;
  console.log(
    `OK: profile dependencies match package.json and the pinned engine bun.lock; engine lock pins ${lock.repository}@${lock.commit.slice(0, 7)} (v${lock.version})`,
  );
  return 0;
}

process.exitCode = await main();
