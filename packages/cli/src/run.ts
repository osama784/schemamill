import { readFile } from 'node:fs/promises';

import type { Diagnostic, Model, ReadResult } from '@schemamill/core';
import { importDump } from '@schemamill/postgres';

import { formatDiagnostics, type Side } from './diagnostics.ts';

/**
 * Shared command plumbing: read one DDL dump per side, import both into the canonical model,
 * and report each side's diagnostics on stderr.
 *
 * stdout belongs to the artifact, so nothing here writes to it. A read failure prints one
 * `schemamill: cannot read <path>: <reason>` line; a thrown import prints one
 * `schemamill: <message>` line; a returned `null` means such a failure was reported, so the
 * command must print no artifact and exit 1. Otherwise each side's diagnostics are written
 * in order and the returned exit code is 1 when either side carried an `error` diagnostic —
 * the artifact is still the caller's to print, and its exit code to apply afterwards.
 */

/** Both imported sides, with the exit code their diagnostics call for. */
export interface ImportedPair {
  readonly baseline: Model;
  readonly target: Model;
  /** 1 when either side reported an `error` diagnostic; 0 otherwise. */
  readonly exitCode: 0 | 1;
}

/**
 * Reads, imports, and reports both sides of a comparison. Returns `null` when a side could
 * not be read or imported — the failure is already on stderr, and the command must not print
 * an artifact.
 */
export async function importPair(
  baselinePath: string,
  targetPath: string,
  verbose: boolean,
): Promise<ImportedPair | null> {
  const baselineDump = await readDump(baselinePath);
  if (baselineDump === null) return null;
  const targetDump = await readDump(targetPath);
  if (targetDump === null) return null;

  const baseline = await importSide(baselineDump);
  if (baseline === null) return null;
  const target = await importSide(targetDump);
  if (target === null) return null;

  const sides: ReadonlyArray<readonly [Side, ReadResult<Model, Diagnostic>]> = [
    ['baseline', baseline],
    ['target', target],
  ];
  for (const [side, result] of sides) {
    process.stderr.write(formatDiagnostics(side, result.diagnostics, verbose));
  }

  return {
    baseline: baseline.model,
    target: target.model,
    exitCode: sides.some(([, result]) =>
      result.diagnostics.some((diagnostic) => diagnostic.kind === 'error'),
    )
      ? 1
      : 0,
  };
}

/** The dump text, or `null` after one stderr line naming the path and the reason. */
async function readDump(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    process.stderr.write(`schemamill: cannot read ${path}: ${reason(error)}\n`);
    return null;
  }
}

/** The import result, or `null` after one stderr line carrying the failure message. */
async function importSide(ddl: string): Promise<ReadResult<Model, Diagnostic> | null> {
  try {
    return await importDump(ddl);
  } catch (error) {
    process.stderr.write(`schemamill: ${reason(error)}\n`);
    return null;
  }
}

/** The message of a thrown value, stringified when it is not an `Error`. */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
