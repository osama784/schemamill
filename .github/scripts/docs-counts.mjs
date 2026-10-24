// Report stale count claims in the docs against counts derived from code.
//
// The four classes are the plan's step-kind classification, its table-phase list, and the live
// suite's scenes and tests. Run `pnpm build` first: `live-scenes.ts` resolves `@schemamill/core`
// through the workspace link to `packages/core/dist`. Report mode is deliberately non-failing
// (exit 0 even on a stale claim or a derivation error); `--check` exits 1 on either.
//
// Usage: node .github/scripts/docs-counts.mjs [--check]

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), '../..');

/** Number words outside this map are claim errors, never silent skips. */
const UNITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const TEENS = [
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

const NUMBER_WORDS = new Map();
for (const [value, word] of UNITS.entries()) NUMBER_WORDS.set(word, value);
for (const [offset, word] of TEENS.entries()) NUMBER_WORDS.set(word, 10 + offset);
for (let tens = 2; tens <= 9; tens += 1) {
  NUMBER_WORDS.set(TENS[tens], tens * 10);
  for (let unit = 1; unit <= 9; unit += 1) {
    NUMBER_WORDS.set(`${TENS[tens]}-${UNITS[unit]}`, tens * 10 + unit);
  }
}

// `in` is here for the literal prose "Drops sit in table phases 2–4"; it precedes a plural
// noun, not a count. The rest are the demonstratives and quantifiers the patterns also meet.
const STOPWORDS = new Set(['the', 'these', 'those', 'all', 'current', 'first', 'last', 'in']);

/** A line is a live-suite claim only when it relates tests and scenes. */
const LIVE_LINE = /tests.*scenes|scenes.*tests/;

const LIVE_PATTERNS = [
  { name: 'liveTests', pattern: /\b(\d+) tests\b/g },
  { name: 'liveScenes', pattern: /grown to (\d+) scenes/g },
  // `the three PostgreSQL 18 scenes` is a different fact than the scene total; the lookbehind
  // also stops the engine starting on the `8` in `18 scenes`.
  { name: 'liveScenes', pattern: /(?<!PostgreSQL )\b(\d+) scenes\b/g },
  { name: 'liveSkipped', pattern: /\b(\d+) skipped\b/g },
  { name: 'pg18Scenes', pattern: /the ([\w-]+) PostgreSQL 18 scenes/g },
  { name: 'allRun', pattern: /all ([\w-]+) run/g },
];

const TABLE_PHASE_PATTERNS = [
  // The lookbehind keeps the possessive `slice's table phases` out of the match.
  { name: 'tablePhases', pattern: /(?<=\s|^)([\w-]+) table phases/g },
  { name: 'tablePhases', pattern: /table phases are now ([\w-]+)/g },
  { name: 'tablePhases', pattern: /([\w-]+)-phase order/g },
];

const STEP_KIND_PATTERNS = [
  { name: 'stepKinds', pattern: /step union is ([\w-]+) kinds/g },
  { name: 'stepKinds', pattern: /all ([\w-]+) (?:current )?kinds/g },
];

const TRANSACTIONAL_PATTERNS = [
  { name: 'transactional', pattern: /the other ([\w-]+) are transactional/g },
  { name: 'transactional', pattern: /the ([\w-]+) transactional asserted/g },
];

/** Whether a path is in the scanned surface: docs/**, except accepted ADRs and snapshots. */
export function isScannedDoc(path) {
  const normalized = path.split(sep).join('/');
  if (normalized === 'CHANGELOG.md') return false;
  if (normalized === 'docs/adr' || normalized.startsWith('docs/adr/')) return false;
  return normalized.startsWith('docs/') && normalized.endsWith('.md');
}

/** Parses a count token: digits, or a number word 0–99, or a documented stopword. */
export function classifyToken(token) {
  if (/^\d+$/.test(token)) return { value: Number(token) };
  const normalized = token.toLowerCase();
  if (NUMBER_WORDS.has(normalized)) return { value: NUMBER_WORDS.get(normalized) };
  if (STOPWORDS.has(normalized)) return { stopword: true };
  return { error: `"${token}" is not a number` };
}

/** Removes balanced parenthesized spans before matching, so historical asides stay out. */
export function stripParentheses(line) {
  let current = line;
  for (;;) {
    const next = current.replace(/\([^()]*\)/g, '');
    if (next === current) return next;
    current = next;
  }
}

function collectMatches(patterns, line, claims, errors) {
  for (const { name, pattern } of patterns) {
    for (const match of line.matchAll(pattern)) {
      const classified = classifyToken(match[1]);
      if (classified.stopword === true) continue;
      if (classified.error !== undefined) {
        errors.push({ message: `${name}: ${classified.error}` });
        continue;
      }
      const duplicate = claims.some(
        (claim) => claim.name === name && claim.value === classified.value,
      );
      if (!duplicate) claims.push({ name, value: classified.value });
    }
  }
}

/** Extracts the count claims and number-word errors from one documentation line. */
export function extractLineClaims(line) {
  const stripped = stripParentheses(line);
  const claims = [];
  const errors = [];

  // Live and phase claims read the stripped line so a historical aside such as
  // `(34 scenes at the time)` stays out. The classification claims on transactions.md:33 sit
  // inside a parenthetical list ("all twenty-six kinds listed, the twenty-four transactional
  // asserted"), so those two classes read the full line; their patterns are narrow enough that
  // parenthetical prose does not match them.
  if (LIVE_LINE.test(stripped)) collectMatches(LIVE_PATTERNS, stripped, claims, errors);
  collectMatches(TABLE_PHASE_PATTERNS, stripped, claims, errors);
  collectMatches(STEP_KIND_PATTERNS, line, claims, errors);
  collectMatches(TRANSACTIONAL_PATTERNS, line, claims, errors);

  return { claims, errors };
}

/**
 * Parses the numbered table-phase list inside plan phase 4. The list starts after the
 * "table phases inside phase 4" heading and ends at the next star-only comment line.
 */
export function parseTablePhases(source) {
  const lines = source.split('\n');
  const heading = lines.findIndex((line) => line.includes('table phases inside phase 4'));
  if (heading === -1) throw new Error('table phase heading not found in plan.ts');

  const numbers = [];
  for (let index = heading + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^ \*\s*$/.test(line)) {
      if (numbers.length > 0) break;
      continue;
    }
    const match = /^ \* (\d+)\. /.exec(line);
    if (match !== null) numbers.push(Number(match[1]));
  }

  if (numbers.length === 0) throw new Error('table phase list not found in plan.ts');
  for (const [index, phase] of numbers.entries()) {
    if (phase !== index + 1) {
      throw new Error(`table phases are not contiguous: expected ${index + 1}, found ${phase}`);
    }
  }
  return numbers.length;
}

/** Counts line-anchored top-level `test(` calls across the postgres test sources. */
export function countPostgresTests(sources) {
  let count = 0;
  for (const source of sources) {
    const matches = source.match(/^\s*test\(/gm);
    count += matches === null ? 0 : matches.length;
  }
  return count;
}

function blockEnd(source, openBrace) {
  let depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  throw new Error('unterminated scene loop in live-pg.test.ts');
}

/** Counts `t.test(` subtests that run after the scene loop, i.e. the always-on proofs. */
export function countAlwaysOnLiveSubtests(source) {
  const loop = source.indexOf('for (const scene of scenes)');
  if (loop === -1) throw new Error('scene loop not found in live-pg.test.ts');
  const openBrace = source.indexOf('{', loop);
  if (openBrace === -1) throw new Error('scene loop body not found in live-pg.test.ts');
  const after = source.slice(blockEnd(source, openBrace));
  const matches = after.match(/\bt\.test\(/g);
  return matches === null ? 0 : matches.length;
}

/** Builds the actual counts from already-derived components. */
export function deriveActuals({
  transactional,
  scenes,
  tablePhases,
  postgresTests,
  alwaysOnLiveSubtests,
}) {
  const classifications = Object.values(transactional);
  return {
    stepKinds: classifications.length,
    transactional: classifications.filter((value) => value).length,
    concurrent: classifications.filter((value) => !value).length,
    tablePhases,
    scenes: scenes.length,
    skippedOnPg16: scenes.filter((scene) => (scene.minServerMajor ?? 13) > 16).length,
    postgresTests,
    alwaysOnLiveSubtests,
    liveSuiteTests: postgresTests + scenes.length + alwaysOnLiveSubtests,
  };
}

async function readPostgresTestSources(repoRoot) {
  const directory = join(repoRoot, 'packages/postgres/src');
  const names = (await readdir(directory)).filter((name) => name.endsWith('.test.ts')).sort();
  return Promise.all(names.map((name) => readFile(join(directory, name), 'utf8')));
}

/** Imports the code sources and derives every actual count. */
export async function loadActuals(repoRoot) {
  const planPath = join(repoRoot, 'packages/core/src/plan.ts');
  const liveScenesPath = join(repoRoot, 'packages/postgres/src/live-scenes.ts');
  const livePgPath = join(repoRoot, 'packages/postgres/src/live-pg.test.ts');

  const [planSource, livePgSource, planModule, scenesModule, testSources] = await Promise.all([
    readFile(planPath, 'utf8'),
    readFile(livePgPath, 'utf8'),
    import(pathToFileURL(planPath).href),
    import(pathToFileURL(liveScenesPath).href),
    readPostgresTestSources(repoRoot),
  ]);

  const { TRANSACTIONAL } = planModule;
  if (typeof TRANSACTIONAL !== 'object' || TRANSACTIONAL === null) {
    throw new Error('plan.ts did not export TRANSACTIONAL');
  }
  const { scenes } = scenesModule;
  if (!Array.isArray(scenes)) throw new Error('live-scenes.ts did not export scenes');

  return deriveActuals({
    transactional: TRANSACTIONAL,
    scenes,
    tablePhases: parseTablePhases(planSource),
    postgresTests: countPostgresTests(testSources),
    alwaysOnLiveSubtests: countAlwaysOnLiveSubtests(livePgSource),
  });
}

async function listMarkdownFiles(directory, docsRoot) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      const relativePath = relative(docsRoot, fullPath).split(sep).join('/');
      if (relativePath === 'adr' || relativePath.startsWith('adr/')) continue;
      files.push(...(await listMarkdownFiles(fullPath, docsRoot)));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(fullPath);
    }
  }
  return files;
}

/** Scans every documented claim line under docs/, with one-based line numbers. */
export async function collectDocClaims(repoRoot) {
  const docsRoot = join(repoRoot, 'docs');
  const files = await listMarkdownFiles(docsRoot, docsRoot);
  const claims = [];
  const errors = [];

  for (const file of files) {
    const relativePath = relative(repoRoot, file).split(sep).join('/');
    if (!isScannedDoc(relativePath)) continue;
    const text = await readFile(file, 'utf8');
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      const extracted = extractLineClaims(line);
      for (const claim of extracted.claims)
        claims.push({ ...claim, file: relativePath, line: index + 1 });
      for (const error of extracted.errors)
        errors.push({ ...error, file: relativePath, line: index + 1 });
    }
  }

  return { claims, errors };
}

const ACTUAL_FOR = {
  liveTests: (actuals) => actuals.liveSuiteTests,
  liveScenes: (actuals) => actuals.scenes,
  liveSkipped: (actuals) => actuals.skippedOnPg16,
  pg18Scenes: (actuals) => actuals.skippedOnPg16,
  allRun: (actuals) => actuals.scenes,
  tablePhases: (actuals) => actuals.tablePhases,
  stepKinds: (actuals) => actuals.stepKinds,
  transactional: (actuals) => actuals.transactional,
};

/** Returns the claims whose stated value differs from the derived actual. */
export function findStaleClaims(claims, actuals) {
  return claims.filter((claim) => ACTUAL_FOR[claim.name](actuals) !== claim.value);
}

/** Formats the report lines: actuals, stale claims, errors, then the summary. */
export function formatReport({ actuals, claims, stale, errors }) {
  const lines = [
    `docs-counts: actual step kinds ${actuals.stepKinds}`,
    `docs-counts: actual transactional ${actuals.transactional}`,
    `docs-counts: actual non-transactional ${actuals.concurrent}`,
    `docs-counts: actual table phases ${actuals.tablePhases}`,
    `docs-counts: actual scenes ${actuals.scenes}`,
    `docs-counts: actual postgres tests ${actuals.postgresTests}`,
    `docs-counts: actual always-on live subtests ${actuals.alwaysOnLiveSubtests}`,
    `docs-counts: actual live-suite tests ${actuals.liveSuiteTests} (${actuals.postgresTests} + ${actuals.scenes} + ${actuals.alwaysOnLiveSubtests})`,
    `docs-counts: actual PostgreSQL 18 scenes skipped on 16 ${actuals.skippedOnPg16}`,
  ];

  for (const claim of stale) {
    const actual = ACTUAL_FOR[claim.name](actuals);
    lines.push(
      `docs-counts: ${claim.file}:${claim.line} ${claim.name} claimed ${claim.value} actual ${actual}`,
    );
  }
  for (const error of errors) {
    lines.push(`docs-counts: error ${error.file}:${error.line} ${error.message}`);
  }
  lines.push(`docs-counts: ${claims.length} claims checked, ${stale.length} stale`);
  return lines;
}

/** Report mode never fails; `--check` fails on a stale claim or a derivation/claim error. */
export function resolveExitCode({ check, staleCount, errorCount }) {
  return check && (staleCount > 0 || errorCount > 0) ? 1 : 0;
}

/** Runs the check, writes the report, and returns the process exit code. */
export async function runDocsCounts({
  repoRoot = REPO_ROOT,
  check = false,
  write = console.log,
} = {}) {
  try {
    const actuals = await loadActuals(repoRoot);
    const { claims, errors } = await collectDocClaims(repoRoot);
    const stale = findStaleClaims(claims, actuals);
    for (const line of formatReport({ actuals, claims, stale, errors })) write(line);
    return resolveExitCode({ check, staleCount: stale.length, errorCount: errors.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    write(`docs-counts: error ${message}`);
    return check ? 1 : 0;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT_PATH) {
  const check = process.argv.slice(2).includes('--check');
  process.exitCode = await runDocsCounts({ check });
}
