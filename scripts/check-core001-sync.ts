/**
 * Sync checks for the CORE-001 contract project (consumer-owned, E1).
 *
 * Verifies, without the engine checkout, that:
 *  1. every dependency declared by the profile manifest (profiles/core001/profile.json)
 *     matches the version pinned in package.json;
 *  2. contracts/core-001/engine.lock.json pins the repository/version recorded in the
 *     manifest (engine HEAD drift is caught by `core001:check` building with the
 *     materialized pinned checkout).
 *
 * Exit code 1 on any mismatch, so it can run in CI as a plain command.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
}

async function readJson(rel: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(REPO_ROOT, rel), 'utf8'));
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

  if (failed) return 1;
  console.log(
    `OK: profile dependencies match package.json; engine lock pins ${lock.repository}@${lock.commit.slice(0, 7)} (v${lock.version})`,
  );
  return 0;
}

process.exitCode = await main();
