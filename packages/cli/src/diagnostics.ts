import type { Diagnostic } from '@schemamill/core';

/**
 * Import diagnostics as the stderr lines the commands print.
 *
 * Diagnostics never share a stream with the artifact: the commands write these lines to
 * stderr, while stdout carries only the diff or the plan. For each side — baseline first,
 * then target — a side with any diagnostics prints one counts line (`2 skipped, 1 failed`,
 * zero categories left out, fixed skipped/flagged/failed order) and then one line per
 * diagnostic in dump order: every `error` always, and every `skip` and `flag` only under
 * `--verbose`.
 *
 * A line names its side and kind, carries the diagnostic's message verbatim, and appends the
 * `line:column` position when the diagnostic has one; the machine-readable `code` stays out
 * of human output.
 */

/** Which side of a comparison a diagnostic came from. */
export type Side = 'baseline' | 'target';

/**
 * `side`'s diagnostics as stderr lines, or the empty string when it has none. `verbose` adds
 * a line per skip and flag; error lines are always present.
 */
export function formatDiagnostics(
  side: Side,
  diagnostics: readonly Diagnostic[],
  verbose: boolean,
): string {
  if (diagnostics.length === 0) return '';

  const lines = [`${side}: ${formatCounts(countDiagnostics(diagnostics))}`];
  for (const diagnostic of diagnostics) {
    if (diagnostic.kind !== 'error' && !verbose) continue;
    lines.push(`${side}: [${diagnostic.kind}] ${diagnostic.message}${formatPosition(diagnostic)}`);
  }
  return `${lines.join('\n')}\n`;
}

interface DiagnosticCounts {
  readonly skipped: number;
  readonly flagged: number;
  readonly failed: number;
}

function countDiagnostics(diagnostics: readonly Diagnostic[]): DiagnosticCounts {
  let skipped = 0;
  let flagged = 0;
  let failed = 0;
  for (const diagnostic of diagnostics) {
    if (diagnostic.kind === 'skip') skipped += 1;
    else if (diagnostic.kind === 'flag') flagged += 1;
    else failed += 1;
  }
  return { skipped, flagged, failed };
}

/** `41 skipped, 2 flagged, 1 failed`, with zero categories left out. */
function formatCounts(counts: DiagnosticCounts): string {
  const parts: string[] = [];
  if (counts.skipped > 0) parts.push(`${counts.skipped} skipped`);
  if (counts.flagged > 0) parts.push(`${counts.flagged} flagged`);
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  return parts.join(', ');
}

/** ` (<line>:<column>)` when the diagnostic has a position, otherwise nothing. */
function formatPosition(diagnostic: Diagnostic): string {
  const position = diagnostic.position;
  return position === undefined ? '' : ` (${position.line}:${position.column})`;
}
