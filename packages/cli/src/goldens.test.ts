import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/**
 * Golden tests for the `compare` and `plan` artifact stdout.
 *
 * Each scene is a dump pair under `test/fixtures`; `<scene>.compare.txt` and `<scene>.plan.txt`
 * under `test/goldens` hold the human command's exact stdout, and every scene's pair exercises the
 * full change vocabulary. JSON scenes instead pin `<scene>.<command>.json.txt` after the D4
 * path/version normalization. Only stdout and the exit code are pinned: diagnostics belong on
 * stderr, and a fixture may legitimately carry a skippable statement, so stderr is not
 * asserted here.
 */

const execFileAsync = promisify(execFile);

/** The built entry point; the package's test script builds first. */
const CLI = fileURLToPath(new URL('../dist/index.js', import.meta.url));

/** One golden scene: the fixture base name, optional extra arguments, and artifact format. */
interface GoldenScene {
  readonly name: string;
  readonly planArgs?: readonly string[];
  /** Extra arguments passed to both commands (e.g. `--json`). */
  readonly args?: readonly string[];
  /** Golden artifact format; the human text artifact is the default. */
  readonly format?: 'text' | 'json';
}

/** Every golden scene, by fixture base name. */
const SCENES: readonly GoldenScene[] = [
  { name: 'all-changes' },
  { name: 'column-attributes', planArgs: ['--target-version', '16'] },
  { name: 'comments' },
  { name: 'constraint-attributes' },
  { name: 'constraint-enforcement', planArgs: ['--target-version', '18'] },
  { name: 'constraints-indexes' },
  { name: 'extensions' },
  { name: 'hazards' },
  { name: 'identity' },
  { name: 'schema-edges' },
  { name: 'sequences' },
  { name: 'views' },
  { name: 'json-rich', args: ['--json'], format: 'json' },
];

/** The 12 human scenes: their stdout assertions and goldens are unchanged by the JSON scenes. */
const TEXT_SCENES = SCENES.filter((scene) => scene.format !== 'json');

/** Structured-JSON scenes: rich DTO payloads with a multi-group plan. */
const JSON_SCENES = SCENES.filter((scene) => scene.format === 'json');

/** Every command whose stdout a golden pins. */
const COMMANDS = ['compare', 'plan'] as const;

interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | undefined;
}

/** Spawns the built CLI and captures both streams and the exit code, success or failure. */
async function runCli(...args: readonly string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', code: failure.code };
  }
}

/** Reads a fixture or golden file next to this test, verbatim. */
const readText = (relativeUrl: string): string =>
  readFileSync(new URL(relativeUrl, import.meta.url), 'utf8');

/** A fixture dump path as a filesystem path. */
const fixturePath = (relativeUrl: string): string =>
  fileURLToPath(new URL(relativeUrl, import.meta.url));

/** A golden's `Hazards:` block — the header and its `  step ` lines — or `null` when absent. */
function hazardsBlock(golden: string): string | null {
  const lines = golden.split('\n');
  const start = lines.indexOf('Hazards:');
  if (start === -1) return null;
  const block = [lines[start]!];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (!lines[index]!.startsWith('  step ')) break;
    block.push(lines[index]!);
  }
  return `${block.join('\n')}\n`;
}

for (const scene of TEXT_SCENES) {
  for (const command of COMMANDS) {
    test(`${command} prints exactly the ${scene.name} golden`, async () => {
      const baseline = fixturePath(`../test/fixtures/${scene.name}.baseline.sql`);
      const target = fixturePath(`../test/fixtures/${scene.name}.target.sql`);

      const result = await runCli(
        command,
        baseline,
        target,
        ...(command === 'plan' ? (scene.planArgs ?? []) : []),
      );

      assert.equal(
        result.code,
        0,
        `schemamill ${command} exited ${String(result.code)}; stderr:\n${result.stderr}`,
      );
      assert.equal(result.stdout, readText(`../test/goldens/${scene.name}.${command}.txt`));
    });
  }
}

test('compare and plan pin the same hazards block for the hazards and identity scenes', () => {
  for (const scene of ['hazards', 'identity'] as const) {
    const compareBlock = hazardsBlock(readText(`../test/goldens/${scene}.compare.txt`));
    const planBlock = hazardsBlock(readText(`../test/goldens/${scene}.plan.txt`));

    assert.ok(
      compareBlock !== null && compareBlock.includes('\n  step '),
      `${scene}.compare.txt carries no hazards`,
    );
    assert.ok(
      planBlock !== null && planBlock.includes('\n  step '),
      `${scene}.plan.txt carries no hazards`,
    );
    assert.equal(compareBlock, planBlock, `${scene}: compare and plan hazards blocks differ`);
  }
});

/** The minimal shape `normalizeJson` touches; the parsed document carries many more keys. */
interface NormalizedJson {
  schemamill: { version: string };
  workspace: { root: string } | null;
  sides: {
    baseline: { source: string; path?: string };
    target: { source: string; path?: string };
  };
}

/**
 * D4 determinism: replace the three machine-specific values — workspace root, dump path, and
 * schemamill version — with fixed placeholders so a golden is invariant across checkouts and
 * releases. `json.ts` deliberately exposes no normalization option, so production keeps its real
 * values and only this golden comparison translates them.
 */
function normalizeJson(stdout: string): string {
  const document = JSON.parse(stdout) as NormalizedJson;
  document.schemamill.version = '<VERSION>';
  if (document.workspace !== null) document.workspace.root = '<WORKSPACE_ROOT>';
  for (const side of [document.sides.baseline, document.sides.target]) {
    if (side.source === 'dump' && side.path !== undefined) side.path = '<DUMP_PATH>';
  }
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** A structured-JSON golden's file, after the D4 normalization. */
const readJsonGolden = (scene: GoldenScene, command: string): string =>
  readText(`../test/goldens/${scene.name}.${command}.json.txt`);

for (const scene of JSON_SCENES) {
  for (const command of COMMANDS) {
    test(`${command} prints exactly the ${scene.name} JSON golden`, async () => {
      const baseline = fixturePath(`../test/fixtures/${scene.name}.baseline.sql`);
      const target = fixturePath(`../test/fixtures/${scene.name}.target.sql`);

      const result = await runCli(
        command,
        baseline,
        target,
        ...(scene.args ?? []),
        ...(command === 'plan' ? (scene.planArgs ?? []) : []),
      );

      assert.equal(
        result.code,
        0,
        `schemamill ${command} exited ${String(result.code)}; stderr:\n${result.stderr}`,
      );
      assert.equal(normalizeJson(result.stdout), readJsonGolden(scene, command));
    });
  }
}

test('JSON goldens are byte-stable across repeated renders', async () => {
  const baseline = fixturePath(`../test/fixtures/json-rich.baseline.sql`);
  const target = fixturePath(`../test/fixtures/json-rich.target.sql`);

  for (const command of COMMANDS) {
    const first = await runCli(command, baseline, target, '--json');
    const second = await runCli(command, baseline, target, '--json');

    assert.equal(first.code, 0, `schemamill ${command} exited ${String(first.code)}`);
    assert.equal(second.code, 0, `schemamill ${command} exited ${String(second.code)}`);
    // Raw bytes must not drift between renders: no timestamps, random IDs, or locale sorts.
    assert.equal(second.stdout, first.stdout, `${command}: a second render changed the bytes`);
    assert.equal(normalizeJson(first.stdout), readJsonGolden(JSON_SCENES[0]!, command));
  }
});
