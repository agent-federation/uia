import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildView } from '../../../profiles/core001/view.js';
import { renderer as core001Renderer } from '../../../profiles/core001/renderer.js';
import type { BuildIdentity } from '../../../contract-builder/spec/lib/identity.js';
import type { Renderer } from '../../../contract-builder/spec/lib/render.js';
import type { CheckContext } from '../../../profiles/core001/context.js';
import type { Entity, ProjectModel, ProvenanceVerification } from '../../../contract-builder/spec/lib/ir.js';

export const LEGACY_TEXT = 'DOC (Rev 1)\nMUST do';

/** Renderer input the engine always supplies on a successful build. */
export const TEST_IDENTITY: BuildIdentity = {
  projectId: 'test-project',
  engineVersion: '0.0.0',
  manifestVersion: '0.1',
  inputDigest: `sha256:${'0'.repeat(64)}`,
  extensions: [],
};

const DOCUMENTS = {
  sources: { slice: { id: 'S', includes: ['#1'], excludes: [] } },
  ontology: {
    document: {
      id: 'DOC',
      title: 't',
      revision: '1',
      source: 'SRC',
      slice: 'S',
      slice_title: 's',
    },
  },
};

export function entity(
  id: string,
  kind: string,
  fields: Record<string, unknown>,
  relations: Record<string, string[]> = {},
): Entity {
  return { id, kind, fields, relations };
}

export function modelWith(entities: Entity[]): ProjectModel {
  const byId = new Map(entities.map((item) => [item.id, item]));
  const byKind = new Map<string, Entity[]>();
  for (const item of entities) {
    const list = byKind.get(item.kind) ?? [];
    list.push(item);
    byKind.set(item.kind, list);
  }

  return {
    manifest: {
      manifestVersion: '0.1',
      project: { id: 't' },
      profile: { id: 'p', version: '1', source: '.' },
      inputs: [],
      sources: [
        {
          id: 'SRC',
          path: 'legacy.md',
          adapter: 'markdown',
          identity: { document: 'DOC', revision: '1' },
        },
      ],
      render: [{ outputs: {} }],
    },
    profile: { id: 'p', version: '1', entityKinds: {}, schemas: {}, documents: [] },
    sources: [{ id: 'SRC', bytes: new TextEncoder().encode(LEGACY_TEXT), adapter: 'markdown' }],
    entities,
    documents: DOCUMENTS,
    byId,
    byKind,
    relations: new Map(),
  };
}

export type TestOutcome = 'found' | 'outside' | 'unknown-locator' | 'unsupported' | 'not-found' | 'not-checked';

/** Attaches the binding and the single verification result a CORE-001 check consumes. */
export function context(model: ProjectModel, outcome: TestOutcome = 'found'): CheckContext {
  for (const item of model.entities) attachVerification(item, outcome);
  return {
    model,
    view: buildView(model),
    legacyText: LEGACY_TEXT,
    legacyName: 'legacy.md',
  };
}

function attachVerification(entity: Entity, outcome: TestOutcome): void {
  if (entity.provenance !== undefined) return;

  const fields = entity.fields;
  const source = entity.kind === 'fragment' || entity.kind === 'decision' ? fields.source : undefined;
  const ref = entity.kind === 'fragment' || entity.kind === 'decision' ? fields.source_ref : undefined;
  const quote =
    entity.kind === 'fragment' ? fields.quote : entity.kind === 'decision' ? fields.source_quote : undefined;
  if (typeof source !== 'string' || typeof ref !== 'string' || typeof quote !== 'string') return;

  const status: ProvenanceVerification['status'] =
    outcome === 'found'
      ? 'verified'
      : outcome === 'unsupported' || outcome === 'not-checked'
        ? 'unavailable'
        : 'failed';
  const checked = outcome !== 'not-checked';

  entity.provenance = { source, ref, quote };
  entity.verification = {
    status,
    record: {
      entity: entity.id,
      source,
      ref,
      verifier: checked ? 'test/verifier' : null,
      method: checked ? 'test:verifyQuote' : 'none',
      checkedAt: null,
      sourceVersion: 'DOC (Rev 1)',
      sourceDigest: checked ? `sha256:${'0'.repeat(64)}` : null,
      outcome,
    },
  };
}

export const PROVISION_FIELDS: Record<string, unknown> = {
  title: 't',
  source_ref: 'SRC#1',
  source_quote: 'MUST do',
  claim_quote: 'MUST do',
  normalized_statement: 'MUST do',
  explications: [],
  source_modality: 'MUST',
  modality_marker: 'MUST',
  normative_effect: 'obligation',
  classification_basis: { kind: 'explicit', quote: 'MUST', text: 't' },
  precondition: null,
  exception: null,
  unresolved_conditions: [],
  outside_slice_refs: [],
  review: { status: 'unreviewed', reviewed_by: null },
};

export const PROVISION_RELATIONS: Record<string, string[]> = {
  fragment: ['F1'],
  terms: [],
  dependsOn: [],
  mentions: [],
};

export function fragment(): Entity {
  return entity('F1', 'fragment', {
    source: 'SRC',
    source_ref: 'SRC#1',
    quote: 'MUST do',
    in_scope: true,
  });
}

const root = fileURLToPath(new URL('../../..', import.meta.url));
/** The engine checkout materialized at the repo root (tests import its spec code statically). */
export const ENGINE_ROOT = path.join(root, 'contract-builder');
const projectDir = path.join(root, 'contracts', 'core-001');
const profileDir = path.join(root, 'profiles', 'core001');
const legacyPath = path.join(root, 'docs', 'CORE-001.md');

/**
 * Copies the project and profile into a temp dir, preserving the committed layout: project
 * inputs from `contracts/core-001`, the profile from `profiles/core001`, so its
 * `../../spec/lib/...` imports stay project-relative and are resolved from the engine root
 * by the build (no source rewriting).
 */
export async function copyProjectWithProfile(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `hook-${name}-`));
  for (const file of ['contract-builder.json', 'sources.yml', 'ontology.yml', 'semantics.json', 'decisions.yml']) {
    await cp(path.join(projectDir, file), path.join(dir, file));
  }
  await cp(path.join(projectDir, 'conformance'), path.join(dir, 'conformance'), {
    recursive: true,
  });
  await cp(profileDir, path.join(dir, 'profiles', 'core001'), { recursive: true });

  const manifestPath = path.join(dir, 'contract-builder.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    profile: { source: string; external?: boolean };
    sources: Array<{ path: string; external?: boolean }>;
  };
  manifest.profile.source = './profiles/core001';
  delete manifest.profile.external;
  manifest.sources[0].path = legacyPath;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return dir;
}

/** A shallow copy of a field bag without the given keys (the repo lint forbids unused vars). */
export function omit(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(obj)) {
    if (!keys.includes(name)) copy[name] = value;
  }
  return copy;
}

/** Consumer-supplied renderer registry, as the CLI wires it. */
export const TEST_RENDERERS: Record<string, Renderer> = {
  [core001Renderer.id]: core001Renderer,
};
