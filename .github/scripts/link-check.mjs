// Check relative links in docs/**/*.md and the root README.md.
//
// Scope: every Markdown file under docs/ (including accepted ADRs) plus README.md. Inline
// Markdown links/images and the HTML attributes `src`, `href`, and `srcset` are checked;
// fenced code blocks are skipped. External targets, protocol-relative targets, and empty
// targets are not checked. A fragment on a `.md` target is verified against GitHub-style
// heading slugs; a fragment on any other file is ignored.
//
// Output: one line per broken link, then a summary. Exit 1 on any broken link or unexpected
// error, 0 on a clean tree. There is no report mode: the check is the tool.
//
// Usage: node .github/scripts/link-check.mjs

import { readdir, readFile, stat } from 'node:fs/promises';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = posix.resolve(posix.dirname(SCRIPT_PATH), '../..');

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const MARKDOWN_LINK = /!?\[[^\]]*\]\(([^)]*)\)/g;
const HTML_ATTRIBUTE = /(?:^|\s)(src|href|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const HEADING = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Blanks every line inside a fenced code block while preserving one-based line numbers. */
export function stripFencedCode(source) {
  const output = [];
  let fence = null;

  for (const line of source.split('\n')) {
    if (fence === null) {
      const opening = FENCE_OPEN.exec(line);
      if (opening === null) {
        output.push(line);
      } else {
        fence = { char: opening[1][0], length: opening[1].length };
        output.push('');
      }
      continue;
    }

    const closing = new RegExp(`^ {0,3}${fence.char}{${fence.length},}\\s*$`);
    if (closing.test(line)) fence = null;
    output.push('');
  }

  return output.join('\n');
}

/** Strips optional `<…>` wrapping and a `"title"`/`'title'` suffix from a link destination. */
function parseDestination(raw) {
  const trimmed = raw.trim();
  const angle = /^<([^>]*)>/.exec(trimmed);
  if (angle !== null) return angle[1].trim();

  const title = /^(.*?)\s+(?:"[^"]*"|'[^']*')\s*$/.exec(trimmed);
  return title === null ? trimmed : title[1].trim();
}

/** Extracts inline Markdown links/images and HTML `src`/`href`/`srcset` targets with lines. */
export function extractLinks(source) {
  const links = [];

  for (const [index, line] of source.split('\n').entries()) {
    for (const match of line.matchAll(MARKDOWN_LINK)) {
      links.push({ line: index + 1, target: parseDestination(match[1]) });
    }

    for (const match of line.matchAll(HTML_ATTRIBUTE)) {
      const name = match[1].toLowerCase();
      const value = match[2] ?? match[3] ?? match[4] ?? '';
      if (name === 'srcset') {
        for (const candidate of value.split(',')) {
          const target = candidate.trim().split(/\s+/)[0];
          if (target !== '') links.push({ line: index + 1, target });
        }
      } else {
        links.push({ line: index + 1, target: value.trim() });
      }
    }
  }

  return links;
}

/** Approximates GitHub's heading slug: markup stripped, punctuation removed, spaces hyphenated. */
export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*+/g, '')
    .replace(/[^\p{L}\p{N}\s\-_]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

/** Returns the anchor slugs defined by a Markdown document's ATX headings. */
export function headingSlugs(source) {
  const slugs = new Set();

  for (const line of stripFencedCode(source).split('\n')) {
    const match = HEADING.exec(line);
    if (match === null) continue;

    const base = slugify(match[1]);
    let slug = base;
    let suffix = 1;
    while (slugs.has(slug)) slug = `${base}-${suffix++}`;
    slugs.add(slug);
  }

  return slugs;
}

async function listScopedFiles(repoRoot) {
  const files = [];

  async function walk(directory, relativeDirectory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }

    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const relativePath = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(posix.join(directory, entry.name), relativePath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(relativePath);
      }
    }
  }

  await walk(posix.join(repoRoot, 'docs'), 'docs');

  try {
    await stat(posix.join(repoRoot, 'README.md'));
    files.push('README.md');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  return files.sort();
}

function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

async function slugsFor(path, cache) {
  const cached = cache.get(path);
  if (cached !== undefined) return cached;

  const slugs = headingSlugs(await readFile(path, 'utf8'));
  cache.set(path, slugs);
  return slugs;
}

/** Resolves one target: `null` when skipped, otherwise `{ ok: true }` or `{ reason }`. */
async function resolveLink({ repoRoot, file, target, anchorCache }) {
  const trimmed = target.trim();
  if (trimmed === '' || SCHEME.test(trimmed) || trimmed.startsWith('//')) return null;

  const hash = trimmed.indexOf('#');
  const pathPart = hash === -1 ? trimmed : trimmed.slice(0, hash);
  const fragment = hash === -1 ? undefined : trimmed.slice(hash + 1);

  const decodedPath = decode(pathPart);
  if (decodedPath === null) return { reason: 'invalid percent-encoding' };

  const sourcePath = posix.join(repoRoot, file);
  const resolved =
    decodedPath === '' ? sourcePath : posix.resolve(posix.dirname(sourcePath), decodedPath);

  const relativePath = posix.relative(repoRoot, resolved);
  if (relativePath === '..' || relativePath.startsWith('../') || posix.isAbsolute(relativePath)) {
    return { reason: 'escapes the repository root' };
  }

  let stats;
  try {
    stats = await stat(resolved);
  } catch (error) {
    if (error.code === 'ENOENT') return { reason: 'missing file or directory' };
    throw error;
  }

  if (stats.isDirectory()) return { ok: true };
  if (!stats.isFile()) return { reason: 'not a file or directory' };

  if (fragment !== undefined && fragment !== '' && resolved.endsWith('.md')) {
    const decodedFragment = decode(fragment);
    if (decodedFragment === null) return { reason: 'invalid percent-encoding' };
    const slugs = await slugsFor(resolved, anchorCache);
    if (!slugs.has(decodedFragment)) return { reason: `missing anchor #${decodedFragment}` };
  }

  return { ok: true };
}

/** Checks every scoped file and returns the checked-link count and the broken links. */
export async function checkLinks({ repoRoot = REPO_ROOT, files } = {}) {
  const scoped = files === undefined ? await listScopedFiles(repoRoot) : [...files].sort();
  const anchorCache = new Map();
  const broken = [];
  let checked = 0;

  for (const file of scoped) {
    const source = await readFile(posix.join(repoRoot, file), 'utf8');
    for (const link of extractLinks(stripFencedCode(source))) {
      const result = await resolveLink({ repoRoot, file, target: link.target, anchorCache });
      if (result === null) continue;
      checked += 1;
      if (result.ok !== true) {
        broken.push({ file, line: link.line, target: link.target, reason: result.reason });
      }
    }
  }

  return { checked, broken };
}

if (process.argv[1] !== undefined && posix.resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    const { checked, broken } = await checkLinks({ repoRoot: REPO_ROOT });
    for (const link of broken) {
      console.log(`link-check: ${link.file}:${link.line} ${link.target} (${link.reason})`);
    }
    console.log(`link-check: ${checked} links checked, ${broken.length} broken`);
    process.exitCode = broken.length > 0 ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`link-check: error ${message}`);
    process.exitCode = 1;
  }
}
