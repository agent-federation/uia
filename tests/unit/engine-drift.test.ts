/**
 * Unit tests for the engine drift check (ODR-ENG-003 D6, epic #220 E4).
 * Covers the pure logic (lock validation, drift verdict) against the real
 * engine.lock.json; the script's end-to-end exit codes are exercised by the
 * nightly engine-drift workflow (UIA_REMOTE_HEAD override keeps this suite offline).
 */
import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { evaluateDrift, validateLock, type EngineLock } from '../../scripts/check-engine-drift.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const LOCK = path.join(REPO_ROOT, 'contracts', 'core-001', 'engine.lock.json');

const pin: EngineLock = {
  schema: 'uia-engine-lock/0.1',
  repository: 'agent-federation/contract-builder',
  commit: '694309940d4afa9035536b0ade6e047c6ac17d69',
  version: '0.1.0',
};

const moved = 'b'.repeat(40);

describe('validateLock', () => {
  test('accepts the committed engine.lock.json', async () => {
    const { lock, problems } = validateLock(JSON.parse(await Bun.file(LOCK).text()));
    expect(problems).toEqual([]);
    expect(lock?.repository).toBe('agent-federation/contract-builder');
    expect(lock?.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(lock?.schema).toBe('uia-engine-lock/0.1');
  });

  test('rejects a foreign repository, bad SHA, bad schema, empty version', () => {
    for (const bad of [
      { ...pin, repository: 'evil/contract-builder' },
      { ...pin, commit: 'deadbeef' },
      { ...pin, schema: 'uia-engine-lock/9.9' },
      { ...pin, version: '' },
    ]) {
      expect(validateLock(bad).problems.length).toBeGreaterThan(0);
    }
    expect(validateLock('nope').problems.length).toBe(1);
  });
});

describe('evaluateDrift', () => {
  test('ok when main matches the pin', () => {
    expect(evaluateDrift(pin, pin.commit)).toEqual({ status: 'ok' });
  });

  test('drift message names the new main SHA', () => {
    const verdict = evaluateDrift(pin, moved);
    expect(verdict.status).toBe('drift');
    if (verdict.status !== 'drift') return;
    expect(verdict.message).toContain(`pin is behind main: ${moved}`);
    expect(verdict.message).toContain('reviewed');
    expect(verdict.newHead).toBe(moved);
  });
});
