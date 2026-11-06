import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkLinks, extractLinks, headingSlugs, slugify, stripFencedCode } from './link-check.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

async function tempRepo(t) {
  const repoRoot = await mkdtemp(join(tmpdir(), 'schemamill-link-check-'));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  return repoRoot;
}

async function writeRepoFile(repoRoot, path, content = '') {
  await mkdir(dirname(join(repoRoot, path)), { recursive: true });
  await writeFile(join(repoRoot, path), content);
}

test('stripFencedCode blanks fenced lines and preserves line numbers', () => {
  const source = [
    '[before](./a.md)',
    '```md',
    '[inside](./missing.md)',
    '```',
    '~~~',
    '<img src="./missing.png">',
    '~~~',
    '[after](./b.md)',
  ].join('\n');

  const stripped = stripFencedCode(source);

  assert.equal(stripped.split('\n').length, source.split('\n').length);
  assert.deepEqual(stripped.split('\n'), [
    '[before](./a.md)',
    '',
    '',
    '',
    '',
    '',
    '',
    '[after](./b.md)',
  ]);
});

test('extractLinks reads markdown images, angle targets, titles, and HTML', () => {
  const source = [
    'A [markdown](./a.md) link.',
    '![image](./b.png "The image")',
    "[angle](<./with space.md> 'The space')",
    '<img alt="x" src="./c.png">',
    '<source srcset="./d.png 1x, ./e.png 2x">',
    '<a href="./f.md">f</a>',
  ].join('\n');

  assert.deepEqual(extractLinks(source), [
    { line: 1, target: './a.md' },
    { line: 2, target: './b.png' },
    { line: 3, target: './with space.md' },
    { line: 4, target: './c.png' },
    { line: 5, target: './d.png' },
    { line: 5, target: './e.png' },
    { line: 6, target: './f.md' },
  ]);
});

test('slugify strips markup and headingSlugs numbers duplicates', () => {
  assert.equal(slugify('The `state` edge'), 'the-state-edge');
  assert.equal(slugify('Deferred gaps'), 'deferred-gaps');
  assert.equal(slugify('**Bold** [link](./x.md)'), 'bold-link');
  assert.equal(slugify('Case Sensitive'), 'case-sensitive');

  const slugs = headingSlugs(
    ['# Repeat', '## Repeat', '### The `state` edge', '```md', '# Not a heading', '```'].join('\n'),
  );

  assert.deepEqual([...slugs], ['repeat', 'repeat-1', 'the-state-edge']);
});

test('accepts files, directories, anchors, fragment-only links, and encoded paths', async (t) => {
  const repoRoot = await tempRepo(t);
  await writeRepoFile(repoRoot, 'docs/b.md', '# Target\n');
  await writeRepoFile(repoRoot, 'docs/with space.md', '# Spaced\n');
  await mkdir(join(repoRoot, 'docs/sub'), { recursive: true });
  await writeRepoFile(
    repoRoot,
    'docs/a.md',
    [
      '[file](./b.md)',
      '[dir](./sub/)',
      '[anchor](#local-heading)',
      '[target anchor](./b.md#target)',
      '[fragment only](#local-heading)',
      '[encoded](./with%20space.md)',
      '',
      '## Local heading',
    ].join('\n'),
  );

  const result = await checkLinks({ repoRoot, files: ['docs/a.md'] });

  assert.deepEqual(result, { checked: 6, broken: [] });
});

test('reports missing files, target anchors, and fragment-only anchors', async (t) => {
  const repoRoot = await tempRepo(t);
  await writeRepoFile(repoRoot, 'docs/b.md', '# Present\n');
  await writeRepoFile(
    repoRoot,
    'docs/a.md',
    ['[file](./missing.md)', '[anchor](./b.md#absent)', '[fragment](#absent)'].join('\n'),
  );

  const result = await checkLinks({ repoRoot, files: ['docs/a.md'] });

  assert.deepEqual(result, {
    checked: 3,
    broken: [
      {
        file: 'docs/a.md',
        line: 1,
        target: './missing.md',
        reason: 'missing file or directory',
      },
      {
        file: 'docs/a.md',
        line: 2,
        target: './b.md#absent',
        reason: 'missing anchor #absent',
      },
      {
        file: 'docs/a.md',
        line: 3,
        target: '#absent',
        reason: 'missing anchor #absent',
      },
    ],
  });
});

test('ignores external, protocol-relative, and empty targets', async (t) => {
  const repoRoot = await tempRepo(t);
  await writeRepoFile(
    repoRoot,
    'docs/a.md',
    [
      '[web](https://example.com/x)',
      '[mail](mailto:team@example.com)',
      '[scheme](notes:thing)',
      '[protocol relative](//example.com/x)',
      '[empty]()',
    ].join('\n'),
  );

  const result = await checkLinks({ repoRoot, files: ['docs/a.md'] });

  assert.deepEqual(result, { checked: 0, broken: [] });
});

test('checks markdown title forms and README-style HTML attributes', async (t) => {
  const repoRoot = await tempRepo(t);
  await writeRepoFile(repoRoot, 'docs/target.md', '# Target\n');
  await writeRepoFile(repoRoot, 'docs/image.png');
  await writeRepoFile(repoRoot, 'docs/image@2x.png');
  await writeRepoFile(
    repoRoot,
    'docs/a.md',
    [
      '[angle](<./target.md>)',
      '[double title](./target.md "The title")',
      "[single title](./target.md 'The title')",
      '<img alt="x" src="./image.png">',
      '<source srcset="./image.png 1x, ./image@2x.png 2x">',
      '<a href="./target.md">target</a>',
    ].join('\n'),
  );

  const result = await checkLinks({ repoRoot, files: ['docs/a.md'] });

  assert.deepEqual(result, { checked: 7, broken: [] });
});

test('ignores links inside fenced code blocks', async (t) => {
  const repoRoot = await tempRepo(t);
  await writeRepoFile(repoRoot, 'docs/target.md', '# Target\n');
  await writeRepoFile(
    repoRoot,
    'docs/a.md',
    [
      '[real](./target.md)',
      '```md',
      '[fake](./missing.md)',
      '```',
      '~~~html',
      '<img src="./missing.png">',
      '~~~',
    ].join('\n'),
  );

  const result = await checkLinks({ repoRoot, files: ['docs/a.md'] });

  assert.deepEqual(result, { checked: 1, broken: [] });
});

test('rejects targets that escape the repository root', async (t) => {
  const repoRoot = await tempRepo(t);
  await writeRepoFile(
    repoRoot,
    'docs/a.md',
    ['[outside](../../outside.md)', '[absolute](/etc/passwd)'].join('\n'),
  );

  const result = await checkLinks({ repoRoot, files: ['docs/a.md'] });

  assert.deepEqual(result, {
    checked: 2,
    broken: [
      {
        file: 'docs/a.md',
        line: 1,
        target: '../../outside.md',
        reason: 'escapes the repository root',
      },
      {
        file: 'docs/a.md',
        line: 2,
        target: '/etc/passwd',
        reason: 'escapes the repository root',
      },
    ],
  });
});

test('accepts duplicate heading suffixes and headings with inline code', async (t) => {
  const repoRoot = await tempRepo(t);
  await writeRepoFile(repoRoot, 'docs/b.md', '## Repeat\n## Repeat\n## The `state` edge\n');
  await writeRepoFile(
    repoRoot,
    'docs/a.md',
    ['[duplicate](./b.md#repeat-1)', '[code](./b.md#the-state-edge)'].join('\n'),
  );

  const result = await checkLinks({ repoRoot, files: ['docs/a.md'] });

  assert.deepEqual(result, { checked: 2, broken: [] });
});

test('the repository tree has no broken relative links', async () => {
  const result = await checkLinks({ repoRoot: REPO_ROOT });

  assert.deepEqual(result.broken, []);
  assert.ok(result.checked > 0);
});
