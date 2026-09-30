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
 * under `test/goldens` hold the command's exact stdout, and every scene's pair exercises the
 * full change vocabulary. Only stdout and the exit code are pinned: diagnostics belong on
 * stderr, and a fixture may legitimately carry a skippable statement, so stderr is not
 * asserted here.
 */

const execFileAsync = promisify(execFile);

/** The built entry point; the package's test script builds first. */
const CLI = fileURLToPath(new URL('../dist/index.js', import.meta.url));

/** Every golden scene, by fixture base name. */
const SCENES = ['all-changes', 'identity', 'sequences'] as const;

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

for (const scene of SCENES) {
  for (const command of COMMANDS) {
    test(`${command} prints exactly the ${scene} golden`, async () => {
      const baseline = fixturePath(`../test/fixtures/${scene}.baseline.sql`);
      const target = fixturePath(`../test/fixtures/${scene}.target.sql`);

      const result = await runCli(command, baseline, target);

      assert.equal(
        result.code,
        0,
        `schemamill ${command} exited ${String(result.code)}; stderr:\n${result.stderr}`,
      );
      assert.equal(result.stdout, readText(`../test/goldens/${scene}.${command}.txt`));
    });
  }
}
