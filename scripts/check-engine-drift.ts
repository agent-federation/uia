/**
 * Engine drift check for the CORE-001 project (ODR-ENG-003 D6, epic #220 E4).
 *
 * Reads contracts/core-001/engine.lock.json, resolves the HEAD of `main` in the
 * locked repository (`agent-federation/contract-builder`) via `git ls-remote`, and
 * fails with a clear message when `main` has moved beyond the pin. Drift must be
 * visible, not silent; the pin advances only through a reviewed UIA pull request —
 * this script never updates the lock.
 *
 * Exit codes: 0 = pin matches main; 1 = drift or an invalid lock.
 * UIA_REMOTE_HEAD overrides the remote query (tests, offline runs, CI plumbing).
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const LOCK_PATH = path.join(REPO_ROOT, 'contracts', 'core-001', 'engine.lock.json');

export interface EngineLock {
  schema: string;
  repository: string;
  commit: string;
  version: string;
}

export type DriftVerdict =
  | { status: 'ok' }
  | { status: 'invalid-lock'; problems: string[] }
  | { status: 'drift'; newHead: string; message: string };

export function validateLock(lock: unknown): { lock?: EngineLock; problems: string[] } {
  const problems: string[] = [];
  if (typeof lock !== 'object' || lock === null || Array.isArray(lock)) {
    return { problems: ['engine.lock.json is not an object'] };
  }
  const candidate = lock as Partial<EngineLock>;
  if (candidate.schema !== 'uia-engine-lock/0.1') {
    problems.push(`unexpected schema ${String(candidate.schema)}`);
  }
  if (typeof candidate.commit !== 'string' || !/^[0-9a-f]{40}$/.test(candidate.commit)) {
    problems.push(`commit is not a full 40-hex SHA: ${String(candidate.commit)}`);
  }
  if (candidate.repository !== 'agent-federation/contract-builder') {
    problems.push(`repository must be "agent-federation/contract-builder", got ${String(candidate.repository)}`);
  }
  if (typeof candidate.version !== 'string' || candidate.version.length === 0) {
    problems.push('version is missing');
  }
  return problems.length === 0 ? { lock: candidate as EngineLock, problems } : { problems };
}

/** Resolves the current HEAD of the pinned repository's `main` branch. */
async function remoteHead(repository: string): Promise<string> {
  const url = `https://github.com/${repository}`;
  return await new Promise<string>((resolve, reject) => {
    execFile('git', ['ls-remote', url, 'refs/heads/main'], (error, stdout) => {
      if (error) {
        reject(new Error(`git ls-remote ${url} failed: ${error.message}`));
        return;
      }
      const match = stdout.match(/^([0-9a-f]{40})\trefs\/heads\/main$/m);
      if (match === null) {
        reject(new Error(`git ls-remote ${url} returned no refs/heads/main entry`));
        return;
      }
      resolve(match[1]);
    });
  });
}

export function evaluateDrift(lock: EngineLock, head: string): DriftVerdict {
  if (head === lock.commit) return { status: 'ok' };
  return {
    status: 'drift',
    newHead: head,
    message:
      `pin is behind main: ${head}\n` +
      `engine.lock.json pins ${lock.repository}@${lock.commit} (v${lock.version}). ` +
      `The pin advances only via a reviewed pull request that updates contracts/core-001/engine.lock.json.`,
  };
}

async function main(): Promise<number> {
  let lock: unknown;
  try {
    lock = JSON.parse(await readFile(LOCK_PATH, 'utf8'));
  } catch (error) {
    console.error(`engine.lock.json is unreadable: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const { lock: pinned, problems } = validateLock(lock);
  if (pinned === undefined) {
    console.error('engine.lock.json is invalid:');
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }

  const head = process.env.UIA_REMOTE_HEAD ?? (await remoteHead(pinned.repository));
  if (!/^[0-9a-f]{40}$/.test(head)) {
    console.error(`remote main head is not a full 40-hex SHA: ${head}`);
    return 1;
  }
  const verdict = evaluateDrift(pinned, head);
  if (verdict.status === 'ok') {
    console.log(`OK: engine pin matches main (${pinned.commit.slice(0, 7)}, v${pinned.version})`);
    return 0;
  }
  if (verdict.status === 'drift') {
    console.error(verdict.message);
    return 1;
  }
  return 1;
}

process.exitCode = await main();
