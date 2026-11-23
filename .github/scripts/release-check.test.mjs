import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  checkReleaseVersions,
  formatStepResult,
  parseArgs,
  pnpmInvocation,
  runSteps,
} from './release-check.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT_PATH = join(REPO_ROOT, '.github/scripts/release-check.mjs');

const VERSION = '1.2.3';
const DRIFTED = '9.9.9';

// The seven release/package version sources, keyed for controlled drift.
const SOURCE_PATHS = {
  root: 'package.json',
  core: 'packages/core/package.json',
  postgres: 'packages/postgres/package.json',
  cli: 'packages/cli/package.json',
  server: 'packages/server/package.json',
  coreIndex: 'packages/core/src/index.ts',
  postgresIndex: 'packages/postgres/src/index.ts',
};

function packageJson(name, version = VERSION) {
  return JSON.stringify({ name, version, private: true });
}

function sourceContents(overrides = {}) {
  return {
    [SOURCE_PATHS.root]: packageJson('schemamill'),
    [SOURCE_PATHS.core]: packageJson('@schemamill/core'),
    [SOURCE_PATHS.postgres]: packageJson('@schemamill/postgres'),
    [SOURCE_PATHS.cli]: packageJson('@schemamill/cli'),
    [SOURCE_PATHS.server]: packageJson('@schemamill/server'),
    [SOURCE_PATHS.coreIndex]: `/** The schemamill version. */\nexport const version = '${VERSION}';\n`,
    [SOURCE_PATHS.postgresIndex]: `import { version as coreVersion } from '@schemamill/core';\nexport const version = '${VERSION}';\n`,
    ...overrides,
  };
}

function changelogContents({ unreleased = true, header = `## [${VERSION}] - 2026-11-23` } = {}) {
  return ['# Changelog', '', ...(unreleased ? ['## [Unreleased]', ''] : []), header, ''].join('\n');
}

async function tempTree(t, contents) {
  const root = await mkdtemp(join(tmpdir(), 'schemamill-release-check-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [relativePath, text] of Object.entries(contents)) {
    const full = join(root, relativePath);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, text);
  }
  return root;
}

test('all seven release/package version sources agree', async (t) => {
  const root = await tempTree(t, { ...sourceContents(), 'CHANGELOG.md': changelogContents() });

  const result = checkReleaseVersions(root);

  assert.equal(result.ok, true);
  assert.equal(result.version, VERSION);
  assert.deepEqual(result.errors, []);
});

test('drift in any one of the seven sources fails and names that source', async (t) => {
  for (const relativePath of Object.values(SOURCE_PATHS)) {
    const overrides = sourceContents();
    const original = overrides[relativePath];
    overrides[relativePath] = original.includes('export const version')
      ? original.replace(`'${VERSION}'`, `'${DRIFTED}'`)
      : packageJson(JSON.parse(original).name, DRIFTED);
    const root = await tempTree(t, { ...overrides, 'CHANGELOG.md': changelogContents() });

    const result = checkReleaseVersions(root);

    assert.equal(result.ok, false, `${relativePath} drift must fail`);
    assert.equal(result.version, null);
    assert.ok(
      result.errors.some((error) => error.includes(relativePath)),
      `errors must name ${relativePath}; got ${JSON.stringify(result.errors)}`,
    );
  }
});

test('a missing source fails and names it (never skipped)', async (t) => {
  const contents = sourceContents();
  delete contents[SOURCE_PATHS.coreIndex];
  const root = await tempTree(t, { ...contents, 'CHANGELOG.md': changelogContents() });

  const result = checkReleaseVersions(root);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes(SOURCE_PATHS.coreIndex)));
  assert.ok(result.errors.some((error) => /missing/i.test(error)));
});

test('an unparseable source fails and names it (never skipped)', async (t) => {
  const root = await tempTree(t, {
    ...sourceContents({
      [SOURCE_PATHS.cli]: 'this is not json',
      [SOURCE_PATHS.postgresIndex]: 'export const version = notAString;\n',
    }),
    'CHANGELOG.md': changelogContents(),
  });

  const result = checkReleaseVersions(root);

  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((error) => error.includes(SOURCE_PATHS.cli) && /unparseable/i.test(error)),
  );
  assert.ok(
    result.errors.some(
      (error) => error.includes(SOURCE_PATHS.postgresIndex) && /unparseable/i.test(error),
    ),
  );
});

test('an ill-shaped version literal fails and names its source', async (t) => {
  const root = await tempTree(t, {
    ...sourceContents({ [SOURCE_PATHS.coreIndex]: "export const version = 'banana';\n" }),
    'CHANGELOG.md': changelogContents(),
  });

  const result = checkReleaseVersions(root);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes(SOURCE_PATHS.coreIndex)));
});

test('a CHANGELOG header mismatch fails and names the CHANGELOG', async (t) => {
  const root = await tempTree(t, {
    ...sourceContents(),
    'CHANGELOG.md': changelogContents({ header: '## [9.9.9] - 2026-11-23' }),
  });

  const result = checkReleaseVersions(root);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('CHANGELOG.md')));
  assert.ok(result.errors.some((error) => error.includes(DRIFTED)));
});

test('a missing [Unreleased] header fails', async (t) => {
  const root = await tempTree(t, {
    ...sourceContents(),
    'CHANGELOG.md': changelogContents({ unreleased: false }),
  });

  const result = checkReleaseVersions(root);

  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((error) => error.includes('CHANGELOG.md') && /Unreleased/.test(error)),
  );
});

test('a CHANGELOG with no dated release header fails', async (t) => {
  const root = await tempTree(t, {
    ...sourceContents(),
    'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n',
  });

  const result = checkReleaseVersions(root);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('CHANGELOG.md')));
});

test('parseArgs accepts --dry-run and rejects unknown flags with usage', () => {
  assert.deepEqual(parseArgs([]), { dryRun: false });
  assert.deepEqual(parseArgs(['--dry-run']), { dryRun: true });

  assert.throws(
    () => parseArgs(['--bogus']),
    (error) => error.message.includes('--bogus') && error.message.includes('usage'),
  );
});

test('pnpmInvocation prefers npm_execpath and selects the right fallback per platform', () => {
  const underPnpm = pnpmInvocation(['build'], {
    platform: 'win32',
    env: { npm_execpath: '/pnpm.cjs' },
  });
  assert.equal(underPnpm.command, process.execPath);
  assert.deepEqual(underPnpm.args, ['/pnpm.cjs', 'build']);
  assert.equal(underPnpm.options.shell ?? false, false);

  const nativeLauncher = pnpmInvocation(['build'], {
    platform: 'win32',
    env: { npm_execpath: 'C:\\pnpm\\pnpm.exe' },
  });
  assert.equal(nativeLauncher.command, 'C:\\pnpm\\pnpm.exe');
  assert.deepEqual(nativeLauncher.args, ['build']);
  assert.equal(nativeLauncher.options.shell ?? false, false);

  const windows = pnpmInvocation(['lint'], { platform: 'win32', env: {} });
  assert.equal(windows.command, 'pnpm.cmd');
  assert.deepEqual(windows.args, ['lint']);
  assert.equal(windows.options.shell, true);

  const posix = pnpmInvocation(['lint'], { platform: 'linux', env: {} });
  assert.equal(posix.command, 'pnpm');
  assert.deepEqual(posix.args, ['lint']);
  assert.equal(posix.options.shell ?? false, false);
});

test('formatStepResult labels PASS and FAIL with the exit code', () => {
  assert.equal(formatStepResult('build', true), 'PASS build');
  assert.equal(formatStepResult('build', false, 3), 'FAIL build (exit 3)');
});

test('runSteps reports each step and stops at the first failure', () => {
  const seen = [];
  const result = runSteps(
    [
      { label: 'first', run: () => ({ ok: true }) },
      { label: 'second', run: () => ({ ok: false, exitCode: 7, detail: 'boom' }) },
      {
        label: 'third',
        run: () => {
          seen.push('third ran');
          return { ok: true };
        },
      },
    ],
    (line) => seen.push(line),
  );

  assert.equal(result.ok, false);
  assert.equal(result.failedStep, 'second');
  assert.equal(result.exitCode, 7);
  assert.deepEqual(seen, ['PASS first', 'FAIL second (exit 7)']);
});

test('integration: the real script fails on injected drift and names the source', async (t) => {
  const root = await tempTree(t, {
    ...sourceContents({
      [SOURCE_PATHS.postgres]: packageJson('@schemamill/postgres', DRIFTED),
    }),
    'CHANGELOG.md': changelogContents(),
  });
  const script = join(root, '.github', 'scripts', 'release-check.mjs');
  await mkdir(dirname(script), { recursive: true });
  await copyFile(SCRIPT_PATH, script);

  const run = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    cwd: root,
    timeout: 30_000,
  });

  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  assert.equal(run.status, 1, output);
  assert.ok(output.includes('FAIL release/package version consistency'), output);
  assert.ok(output.includes(SOURCE_PATHS.postgres), output);
});

test('integration: the real script rejects an unknown flag with a usage error', async (t) => {
  const root = await tempTree(t, { ...sourceContents(), 'CHANGELOG.md': changelogContents() });
  const script = join(root, '.github', 'scripts', 'release-check.mjs');
  await mkdir(dirname(script), { recursive: true });
  await copyFile(SCRIPT_PATH, script);

  const run = spawnSync(process.execPath, [script, '--bogus'], {
    encoding: 'utf8',
    cwd: root,
    timeout: 30_000,
  });

  assert.equal(run.status, 1);
  assert.ok(`${run.stdout ?? ''}${run.stderr ?? ''}`.includes('usage'));
});

test('static: the script contains no release-act calls', () => {
  const source = readFileSync(SCRIPT_PATH, 'utf8');
  for (const forbidden of ['git tag', 'git push', 'git commit', 'gh release', 'gh pr']) {
    assert.ok(!source.includes(forbidden), `release-check.mjs must not contain "${forbidden}"`);
  }
});
