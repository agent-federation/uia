/**
 * Shared engine-pin verifier for the CORE-001 harness and checks.
 *
 * Fails closed unless the resolved checkout matches engine.lock.json: its git HEAD must
 * equal the pinned commit and its package version must equal the locked version. Set
 * UIA_ALLOW_UNPINNED_ENGINE=1 to develop against a different checkout; the mismatch is
 * then reported as a warning instead of an error.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface EnginePin {
  commit: string;
  version: string;
}

export async function verifyEnginePin(candidate: string, pin: EnginePin): Promise<void> {
  const problems: string[] = [];

  const gitHead = await new Promise<string>((resolve) => {
    execFile('git', ['-C', candidate, 'rev-parse', 'HEAD'], (error, stdout) => {
      resolve(error ? '' : stdout.trim());
    });
  });
  if (gitHead === '') {
    problems.push('not a git checkout (cannot read HEAD)');
  } else if (gitHead !== pin.commit) {
    problems.push(
      `HEAD is ${gitHead.slice(0, 7)}, lock pins ${pin.commit.slice(0, 7)}` +
        ` — run "git -C ${candidate} fetch && git -C ${candidate} checkout ${pin.commit}"`,
    );
  }

  try {
    const pkg = JSON.parse(await readFile(path.join(candidate, 'package.json'), 'utf8')) as {
      version?: string;
    };
    if (pkg.version !== pin.version) {
      problems.push(`package version is ${pkg.version ?? 'unknown'}, lock pins ${pin.version}`);
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
