// One side-effect-free readiness gate for the release procedure: it checks that the
// release/package version agrees across its seven sources, runs the docs checks and the five
// gates, and finishes with a clean-clone install plus the README CLI smokes. It never performs
// a release act — it only reads, clones into a throwaway directory, installs, builds, and tests.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const GATE_TIMEOUT_MS = 10 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const BUILD_TIMEOUT_MS = 5 * 60 * 1000;
const CLONE_TIMEOUT_MS = 2 * 60 * 1000;
const SMOKE_TIMEOUT_MS = 60 * 1000;
const MAX_CAPTURED_CHARS = 4000;

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** The seven fields a version bump changes together. */
const VERSION_SOURCES = [
  { label: 'root package.json', path: 'package.json', parse: parsePackageVersion },
  {
    label: '@schemamill/core package.json',
    path: 'packages/core/package.json',
    parse: parsePackageVersion,
  },
  {
    label: '@schemamill/postgres package.json',
    path: 'packages/postgres/package.json',
    parse: parsePackageVersion,
  },
  {
    label: '@schemamill/cli package.json',
    path: 'packages/cli/package.json',
    parse: parsePackageVersion,
  },
  {
    label: '@schemamill/server package.json',
    path: 'packages/server/package.json',
    parse: parsePackageVersion,
  },
  {
    label: 'packages/core/src/index.ts version literal',
    path: 'packages/core/src/index.ts',
    parse: parseTypeScriptVersion,
  },
  {
    label: 'packages/postgres/src/index.ts version literal',
    path: 'packages/postgres/src/index.ts',
    parse: parseTypeScriptVersion,
  },
];

/** Parse `--dry-run`; every other argument is a usage error. */
export function parseArgs(argv) {
  let dryRun = false;
  for (const argument of argv) {
    if (argument === '--dry-run') {
      dryRun = true;
    } else {
      throw new Error(`unknown argument: ${argument}\nusage: pnpm release:check [--dry-run]`);
    }
  }
  return { dryRun };
}

function parseVersionLiteral(text) {
  const version = text.trim();
  if (!VERSION_PATTERN.test(version))
    throw new Error(`not an X.Y.Z release/package version: ${text}`);
  return version;
}

function parsePackageVersion(text) {
  const manifest = JSON.parse(text);
  if (manifest === null || typeof manifest.version !== 'string') {
    throw new Error('no version string');
  }
  return parseVersionLiteral(manifest.version);
}

function parseTypeScriptVersion(text) {
  const match = text.match(/\bexport\s+const\s+version\s*=\s*['"]([^'"]+)['"]/);
  if (match === null) throw new Error('no exported version literal');
  return parseVersionLiteral(match[1]);
}

/**
 * Check the seven release/package version sources and the newest CHANGELOG header.
 * Every source must exist and parse; a missing or unparseable one is a named FAIL, never a skip.
 * @param {string} root
 * @returns {{ ok: boolean, version: string | null, errors: string[] }}
 */
export function checkReleaseVersions(root) {
  const errors = [];
  const parsed = [];

  for (const source of VERSION_SOURCES) {
    let text;
    try {
      text = readFileSync(join(root, source.path), 'utf8');
    } catch (error) {
      errors.push(`${source.path} (${source.label}): missing or unreadable (${error.message})`);
      continue;
    }
    try {
      parsed.push({ path: source.path, version: source.parse(text) });
    } catch (error) {
      errors.push(`${source.path} (${source.label}): unparseable (${error.message})`);
    }
  }

  let changelogText;
  try {
    changelogText = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  } catch (error) {
    errors.push(`CHANGELOG.md: missing or unreadable (${error.message})`);
  }

  let headerVersion = null;
  if (changelogText !== undefined) {
    if (!/^##\s+\[Unreleased\]\s*$/m.test(changelogText)) {
      errors.push('CHANGELOG.md: missing [Unreleased] header');
    }
    const header = changelogText.match(/^##\s+\[(\d+\.\d+\.\d+)\]\s+-\s+\d{4}-\d{2}-\d{2}\s*$/m);
    if (header === null) {
      errors.push('CHANGELOG.md: no newest ## [X.Y.Z] - YYYY-MM-DD header');
    } else {
      headerVersion = header[1];
    }
  }

  let version = null;
  if (errors.length === 0) {
    const distinct = [...new Set(parsed.map((entry) => entry.version))];
    if (distinct.length !== 1) {
      errors.push(
        `release/package version drift: ${parsed.map((entry) => `${entry.path}=${entry.version}`).join(', ')}`,
      );
    } else {
      version = distinct[0];
      if (headerVersion !== version) {
        errors.push(
          `CHANGELOG.md newest header [${headerVersion}] does not match release/package version ${version}`,
        );
      }
    }
  }

  if (errors.length > 0) version = null;
  return { ok: errors.length === 0, version, errors };
}

/**
 * Choose how to launch pnpm. Under pnpm, `npm_execpath` points at the JS launcher, which Node can
 * spawn with its own executable — this is what makes the shim work on Windows. Otherwise fall
 * back to the platform's launcher binary.
 * @param {string[]} args
 * @param {{ platform?: string, env?: Record<string, string | undefined> }} [context]
 */
export function pnpmInvocation(args, { platform = process.platform, env = process.env } = {}) {
  const launcher = env.npm_execpath;
  if (launcher) {
    // A `.js`/`.cjs`/`.mjs` launcher is a module and needs Node. Some pnpm installs expose a
    // native `.exe` instead, which Node cannot load as a module; spawn that binary directly.
    if (/\.(?:c|m)?js$/i.test(launcher)) {
      return { command: process.execPath, args: [launcher, ...args], options: {} };
    }
    return { command: launcher, args: [...args], options: {} };
  }
  if (platform === 'win32') {
    return { command: 'pnpm.cmd', args: [...args], options: { shell: true } };
  }
  return { command: 'pnpm', args: [...args], options: {} };
}

function bounded(text) {
  const value = String(text ?? '');
  return value.length <= MAX_CAPTURED_CHARS ? value : `${value.slice(0, MAX_CAPTURED_CHARS)}…`;
}

function runCommand(command, args, { cwd, timeout, ...options } = {}) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    ...options,
  });
}

function runPnpm(args, options = {}) {
  const invocation = pnpmInvocation(args);
  return runCommand(invocation.command, invocation.args, { ...options, ...invocation.options });
}

function commandFailure(tool, result) {
  if (result.error?.code === 'ENOENT') return `${tool} was not found on PATH`;
  if (result.error?.code === 'ETIMEDOUT' || result.killed) {
    return `${tool} timed out or was killed (${result.error?.message ?? 'timeout'})`;
  }
  if (result.error) return `${tool} could not start: ${result.error.message}`;
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  return output === '' ? `${tool} exited with no output` : output;
}

function failure(detail) {
  return { ok: false, exitCode: 1, detail: bounded(detail) };
}

/** Format one step's report line. */
export function formatStepResult(label, ok, exitCode) {
  return ok ? `PASS ${label}` : `FAIL ${label} (exit ${exitCode ?? 1})`;
}

/** Run labeled steps in order, reporting each and stopping at the first failure. */
export function runSteps(steps, report = () => {}) {
  for (const step of steps) {
    const result = step.run();
    report(formatStepResult(step.label, result.ok, result.exitCode), result);
    if (!result.ok) {
      return {
        ok: false,
        failedStep: step.label,
        exitCode: result.exitCode ?? 1,
        detail: result.detail,
      };
    }
  }
  return { ok: true };
}

/**
 * D4: clone the current repository into a throwaway directory, install and build there, and run
 * the README's CLI smokes. The init workspace lives in a second throwaway directory outside the
 * clone. Only directories created here are removed, in `finally`.
 * @param {string} root
 * @param {string} version
 */
export function cleanCloneSmoke(root, version) {
  let cloneParent;
  let workspaceParent;
  try {
    const topLevel = runCommand('git', ['rev-parse', '--show-toplevel'], {
      cwd: root,
      timeout: SMOKE_TIMEOUT_MS,
    });
    if (topLevel.error?.code === 'ENOENT') return failure('git was not found on PATH');
    if (topLevel.status !== 0)
      return failure(`git rev-parse failed: ${commandFailure('git', topLevel)}`);
    const sourceRoot = topLevel.stdout.trim();
    if (sourceRoot === '') return failure('git rev-parse returned no repository root');

    cloneParent = mkdtempSync(join(tmpdir(), 'schemamill-release-clone-'));
    workspaceParent = mkdtempSync(join(tmpdir(), 'schemamill-release-workspace-'));
    const clone = join(cloneParent, 'repo');

    const cloneResult = runCommand('git', ['clone', '--no-hardlinks', sourceRoot, clone], {
      timeout: CLONE_TIMEOUT_MS,
    });
    if (cloneResult.status !== 0)
      return failure(`git clone failed: ${commandFailure('git', cloneResult)}`);

    // Capture the absolute path before any `cd` — the export smoke runs from the workspace.
    const cli = resolve(clone, 'packages/cli/dist/index.js');
    const fixtureDir = resolve(clone, 'packages/cli/test/fixtures');
    const baseline = join(fixtureDir, 'extensions.baseline.sql');
    const target = join(fixtureDir, 'extensions.target.sql');
    for (const fixture of [baseline, target]) {
      if (!existsSync(fixture))
        return failure(`clean clone is missing tracked fixture: ${fixture}`);
    }

    const install = runPnpm(['install', '--frozen-lockfile'], {
      cwd: clone,
      timeout: INSTALL_TIMEOUT_MS,
    });
    if (install.status !== 0)
      return failure(`clean-clone install failed: ${commandFailure('pnpm', install)}`);

    const build = runPnpm(['build'], { cwd: clone, timeout: BUILD_TIMEOUT_MS });
    if (build.status !== 0)
      return failure(`clean-clone build failed: ${commandFailure('pnpm', build)}`);

    const node = process.execPath;
    const help = runCommand(node, [cli, '--help'], { cwd: clone, timeout: SMOKE_TIMEOUT_MS });
    if (help.status !== 0) return failure(`--help smoke failed: ${commandFailure('node', help)}`);
    for (const command of ['compare', 'export', 'init', 'plan']) {
      if (!help.stdout.includes(command))
        return failure(`--help output does not list the command ${command}`);
    }

    const versionResult = runCommand(node, [cli, '--version'], {
      cwd: clone,
      timeout: SMOKE_TIMEOUT_MS,
    });
    if (versionResult.status !== 0) {
      return failure(`--version smoke failed: ${commandFailure('node', versionResult)}`);
    }
    const printedVersion = versionResult.stdout.trim();
    if (printedVersion !== version) {
      return failure(`--version printed ${printedVersion}, expected ${version}`);
    }

    for (const command of ['compare', 'plan']) {
      const result = runCommand(node, [cli, command, baseline, target], {
        cwd: clone,
        timeout: SMOKE_TIMEOUT_MS,
      });
      if (result.status !== 0) {
        return failure(`${command} smoke failed: ${commandFailure('node', result)}`);
      }
    }

    const workspace = join(workspaceParent, 'workspace');
    const initResult = runCommand(node, [cli, 'init', workspace, '--from', baseline], {
      cwd: clone,
      timeout: SMOKE_TIMEOUT_MS,
    });
    if (initResult.status !== 0)
      return failure(`init smoke failed: ${commandFailure('node', initResult)}`);
    const model = join(workspace, '.schemamill', 'model.json');
    if (!existsSync(model)) return failure(`init smoke did not create ${model}`);

    const exportResult = runCommand(node, [cli, 'export'], {
      cwd: workspace,
      timeout: SMOKE_TIMEOUT_MS,
    });
    if (exportResult.status !== 0) {
      return failure(`export smoke failed: ${commandFailure('node', exportResult)}`);
    }

    return { ok: true };
  } catch (error) {
    return failure(`clean-clone smoke threw: ${error.message}`);
  } finally {
    if (cloneParent !== undefined) rmSync(cloneParent, { recursive: true, force: true });
    if (workspaceParent !== undefined) rmSync(workspaceParent, { recursive: true, force: true });
  }
}

/** Informational only — the release steps a human follows after this gate is green. */
function printRunbookPreview() {
  process.stdout.write(
    [
      '',
      '--- Informational: branch-pr-flow release sequence (printed only, NOT executed;',
      '    not a complete human checklist) ---',
      '    1. Check out dev and pull origin dev.',
      '    2. Cut the CHANGELOG section for the version, commit it, and update dev.',
      '    3. Open the release PR from dev to main with that changelog section as its body.',
      '    4. Merge the release PR into main.',
      '    5. Check out main and pull, tag v<version>, publish the tag, and create the',
      '       published release with notes.',
      '    6. Merge main back into dev and update dev.',
      '    See .agents/skills/branch-pr-flow/SKILL.md for the exact commands.',
      '--- End informational preview ---',
      '',
    ].join('\n'),
  );
}

/** Run the full check set; `--dry-run` adds only the informational preview. */
export function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }

  let releaseVersion = null;
  const report = (line, result) => {
    process.stdout.write(`${line}\n`);
    if (!result.ok && result.detail) {
      for (const text of result.detail.split('\n').filter(Boolean)) {
        process.stdout.write(`    ${text}\n`);
      }
    }
  };

  const steps = [
    {
      label: 'release/package version consistency',
      run: () => {
        const result = checkReleaseVersions(REPO_ROOT);
        releaseVersion = result.version;
        return { ok: result.ok, exitCode: 1, detail: result.errors.join('\n') };
      },
    },
    {
      label: 'docs:counts --check',
      run: () => {
        const result = runPnpm(['docs:counts', '--check'], {
          cwd: REPO_ROOT,
          timeout: GATE_TIMEOUT_MS,
        });
        return {
          ok: result.status === 0,
          exitCode: result.status ?? 1,
          detail: result.status === 0 ? '' : commandFailure('pnpm', result),
        };
      },
    },
    {
      label: 'docs:links',
      run: () => {
        const result = runPnpm(['docs:links'], { cwd: REPO_ROOT, timeout: GATE_TIMEOUT_MS });
        return {
          ok: result.status === 0,
          exitCode: result.status ?? 1,
          detail: result.status === 0 ? '' : commandFailure('pnpm', result),
        };
      },
    },
  ];

  for (const script of ['build', 'lint', 'typecheck', 'test', 'format:check']) {
    steps.push({
      label: script,
      run: () => {
        const result = runPnpm([script], { cwd: REPO_ROOT, timeout: GATE_TIMEOUT_MS });
        return {
          ok: result.status === 0,
          exitCode: result.status ?? 1,
          detail: result.status === 0 ? '' : commandFailure('pnpm', result),
        };
      },
    });
  }

  steps.push({
    label: 'clean-clone smoke',
    run: () => {
      if (releaseVersion === null) return failure('no release/package version was established');
      const result = cleanCloneSmoke(REPO_ROOT, releaseVersion);
      return { ok: result.ok, exitCode: result.exitCode ?? 1, detail: result.detail };
    },
  });

  const outcome = runSteps(steps, report);
  if (options.dryRun) printRunbookPreview();
  return outcome.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
