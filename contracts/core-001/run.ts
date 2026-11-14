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
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

interface EngineLock {
  schema: string;
  repository: string;
  commit: string;
  version: string;
  checkout: string;
}

const COMMITTED_ARTIFACT = path.join(HERE, "output", "CORE-001.draft.md");
const PROJECT_FILES = [
  "contract-builder.json",
  "sources.yml",
  "ontology.yml",
  "semantics.json",
  "decisions.yml",
  "conformance/cases.yml",
] as const;

async function loadEngineLock(): Promise<EngineLock> {
  const raw = await readFile(path.join(HERE, "engine.lock.json"), "utf8");
  return JSON.parse(raw) as EngineLock;
}

async function resolveEngineRoot(lock: EngineLock): Promise<string> {
  const candidates = [
    process.env.UIA_ENGINE_ROOT ?? "",
    path.resolve(HERE, lock.checkout),
    path.resolve(REPO_ROOT, "..", "contract-builder"),
  ].filter((candidate) => candidate.length > 0);
  for (const candidate of candidates) {
    const buildLib = path.join(candidate, "spec", "lib", "build.ts");
    try {
      await readFile(buildLib);
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  throw new Error(
    `Engine checkout not found for ${lock.repository}@${lock.commit.slice(0, 7)}. ` +
      `Clone it to "${path.join(REPO_ROOT, "contract-builder")}" or set UIA_ENGINE_ROOT. ` +
      `Checked: ${candidates.join(", ")}`,
  );
}

/**
 * Copies the project into a temp workspace that mirrors the repository layout:
 * `<root>/contracts/core-001`, `<root>/profiles/core001`, `<root>/docs/CORE-001.md`. The
 * authored relative manifest paths (`../../profiles/core001`, `../../docs/CORE-001.md`) stay
 * valid, and engine-owned profile imports resolve from the explicit engine root.
 */
async function prepareWorkspace(engineRoot: string): Promise<{ root: string; projectDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "uia-core001-"));
  const projectDir = path.join(root, "contracts", "core-001");
  await mkdir(projectDir, { recursive: true });
  for (const file of PROJECT_FILES) {
    await cp(path.join(HERE, file), path.join(projectDir, file));
  }
  await cp(path.join(REPO_ROOT, "profiles", "core001"), path.join(root, "profiles", "core001"), {
    recursive: true,
  });
  await mkdir(path.join(root, "docs"), { recursive: true });
  await cp(path.join(REPO_ROOT, "docs", "CORE-001.md"), path.join(root, "docs", "CORE-001.md"));
  // The engine reads its own bun.lock (engineRoot/bun.lock) for the profile closure preflight,
  // never the consumer's. Mirror the real dependency tree instead of copying a lockfile whose
  // integrity entries would not match this machine's node_modules.
  await cp(
    path.join(engineRoot, "node_modules"),
    path.join(root, "node_modules"),
    { recursive: true },
  );
  return { root, projectDir };
}

async function main(argv: string[]): Promise<number> {
  const write = argv.includes("--write");
  if (argv.some((arg) => !["--write", "--check"].includes(arg))) {
    console.error("Usage: bun contracts/core-001/run.ts [--write|--check]");
    return 1;
  }
  const lock = await loadEngineLock();
  const engineRoot = await resolveEngineRoot(lock);

  const { runBuild } = (await import(
    pathToFileURL(path.join(engineRoot, "spec", "lib", "build.js")).href
  )) as typeof import("@/../contract-builder/spec/lib/build.js");
  const { loadProfileRenderers } = (await import(
    pathToFileURL(path.join(engineRoot, "spec", "cli-renderers.js")).href
  )) as typeof import("@/../contract-builder/spec/cli-renderers.js");

  const rendererModule = path.join(REPO_ROOT, "profiles", "core001", "renderer.ts");
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
      mode: "draft",
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
      console.error(
        `Build blocked (exit ${result.exitCode}, blockedBy=${result.blockedBy ?? "null"})`,
      );
      return 1;
    }

    const generatedPath = path.join(projectDir, "output", "CORE-001.draft.md");
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
