import { readFile } from 'node:fs/promises';

import type { Diagnostic, Model, ReadResult } from '@schemamill/core';
import { resolveWorkspace } from '@schemamill/core';
import { importDump } from '@schemamill/postgres';

import { formatDiagnostics, hasErrors, type Side } from './diagnostics.ts';

/**
 * Shared command plumbing: turn each side of a comparison into a canonical model — reading and
 * importing a DDL dump, or resolving the workspace model — and report each side's diagnostics
 * on stderr.
 *
 * stdout belongs to the artifact, so nothing here writes to it. A read failure prints one
 * `schemamill: cannot read <path>: <reason>` line; a thrown import prints one
 * `schemamill: <message>` line; a workspace resolution failure prints one `schemamill:
 * <message>` line carrying core's diagnostic verbatim; a returned `null` means such a failure
 * was reported, so the command must print no artifact and exit 1. Otherwise each imported side's
 * diagnostics are written in order — baseline first, then target — and the returned exit code is
 * 1 when either side carried an `error` diagnostic; a workspace side contributes none.
 *
 * The side rules, settled by the slice brief:
 * - R1. Two paths and no flags: today's two-dump behavior, byte-identical.
 * - R2. One path and no flags: the path is the target, and the baseline resolves from the
 *   workspace. Commander fills the lone positional as `baseline`, so `mapSides` reassigns it.
 * - R3. One path with `--baseline-workspace` is R2's explicit form.
 * - R4. One path with `--target-workspace`: the path is the baseline, and the target resolves
 *   from the workspace.
 * - R5–R7. Both flags, one flag with two paths, and zero paths are usage errors, validated by
 *   `mapSides` before any filesystem access.
 * - R8. A side resolves only when it has no path: the workspace side is
 *   `resolveWorkspace(process.cwd())` — the CLI never re-walks — so the nearest marker wins and
 *   a corrupt nearest root is reported, not skipped. At most one side resolves per invocation.
 * - R9. Sides are processed baseline → target, each resolved-or-read before the next; the first
 *   failure is the only report.
 */

/** One side of a comparison: a dump path to read, or the workspace-resolved model. */
export type SideSource =
  { readonly kind: 'path'; readonly path: string } | { readonly kind: 'workspace' };

/** The positionals and workspace flags commander parsed for a two-sided command. */
export interface SideArguments {
  /** The first positional; a lone path arrives here and is treated as the target. */
  readonly baseline?: string;
  /** The second positional. */
  readonly target?: string;
  readonly baselineWorkspace?: boolean;
  readonly targetWorkspace?: boolean;
}

/** The two side sources, or the usage error the command must report (R5–R7). */
export type SideMapping =
  | { readonly ok: true; readonly baseline: SideSource; readonly target: SideSource }
  | { readonly ok: false; readonly message: string };

/**
 * Maps the parsed positionals and flags to side sources, applying the rules in order:
 * R5 (both flags) → R6 (one flag with two paths) → R7 (no path at all) → R1–R4. A usage error
 * carries its complete `error: …` message; the command emits it through commander's error
 * machinery, which writes the message verbatim to stderr and exits 1 — with no artifact and no
 * filesystem access first.
 */
export function mapSides(args: SideArguments): SideMapping {
  const paths = [args.baseline, args.target].filter((path) => path !== undefined);
  const baselineWorkspace = args.baselineWorkspace === true;
  const targetWorkspace = args.targetWorkspace === true;

  if (baselineWorkspace && targetWorkspace) {
    return {
      ok: false,
      message: 'error: --baseline-workspace and --target-workspace cannot be combined',
    };
  }
  if (paths.length === 2) {
    if (baselineWorkspace || targetWorkspace) {
      const flag = baselineWorkspace ? '--baseline-workspace' : '--target-workspace';
      return { ok: false, message: `error: ${flag} cannot be combined with two paths` };
    }
    return {
      ok: true,
      baseline: { kind: 'path', path: paths[0]! },
      target: { kind: 'path', path: paths[1]! },
    };
  }
  if (paths.length === 0) {
    return {
      ok: false,
      message: 'error: name at least one dump path (the workspace can fill the other side)',
    };
  }

  // One path: the workspace fills the side the flags leave open — the baseline by default
  // (R2/R3), the target for `--target-workspace` (R4).
  const path: SideSource = { kind: 'path', path: paths[0]! };
  const workspace: SideSource = { kind: 'workspace' };
  return targetWorkspace
    ? { ok: true, baseline: path, target: workspace }
    : { ok: true, baseline: workspace, target: path };
}

/** Both imported sides, with the exit code their diagnostics call for. */
export interface ImportedPair {
  readonly baseline: Model;
  readonly target: Model;
  /** 1 when either side reported an `error` diagnostic; 0 otherwise. */
  readonly exitCode: 0 | 1;
}

/** One side turned into a model, beside the dump import result when it had one. */
interface SidedModel {
  readonly model: Model;
  /** The path side's import result; `null` for a workspace side, which carries no diagnostics. */
  readonly result: ReadResult<Model, Diagnostic> | null;
}

/**
 * Resolves, reads, and imports both sides of a comparison. Returns `null` when a side could not
 * be resolved, read, or imported — the failure is already on stderr, and the command must not
 * print an artifact.
 */
export async function importPair(
  baselineSource: SideSource,
  targetSource: SideSource,
  verbose: boolean,
): Promise<ImportedPair | null> {
  const baseline = await sideModel(baselineSource);
  if (baseline === null) return null;
  const target = await sideModel(targetSource);
  if (target === null) return null;

  const sides: ReadonlyArray<readonly [Side, SidedModel]> = [
    ['baseline', baseline],
    ['target', target],
  ];
  for (const [side, imported] of sides) {
    if (imported.result !== null) {
      process.stderr.write(formatDiagnostics(side, imported.result.diagnostics, verbose));
    }
  }

  return {
    baseline: baseline.model,
    target: target.model,
    exitCode: sides.some(([, imported]) => carriesError(imported)) ? 1 : 0,
  };
}

/** One side's model, or `null` after the failure was reported (R8, R9). */
async function sideModel(source: SideSource): Promise<SidedModel | null> {
  if (source.kind === 'workspace') {
    const resolution = await resolveWorkspace(process.cwd());
    if (!resolution.ok) {
      process.stderr.write(`schemamill: ${resolution.diagnostic.message}\n`);
      return null;
    }
    return { model: resolution.model, result: null };
  }

  const dump = await readDump(source.path);
  if (dump === null) return null;
  const result = await importSide(dump);
  if (result === null) return null;
  return { model: result.model, result };
}

/** The dump text, or `null` after one stderr line naming the path and the reason. */
export async function readDump(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    process.stderr.write(`schemamill: cannot read ${path}: ${reason(error)}\n`);
    return null;
  }
}

/**
 * The complete standard input as text, or `null` after one stderr line naming the reason.
 *
 * Reads to EOF: the encoding is fixed to UTF-8, and every chunk is appended in arrival order.
 * An immediate EOF therefore resolves the empty string — a successful, empty import.
 */
export async function readStdin(): Promise<string | null> {
  try {
    process.stdin.setEncoding('utf8');
    let text = '';
    for await (const chunk of process.stdin) {
      text += chunk;
    }
    return text;
  } catch (error) {
    process.stderr.write(`schemamill: cannot read stdin: ${reason(error)}\n`);
    return null;
  }
}

/** The import result, or `null` after one stderr line carrying the failure message. */
export async function importSide(ddl: string): Promise<ReadResult<Model, Diagnostic> | null> {
  try {
    return await importDump(ddl);
  } catch (error) {
    process.stderr.write(`schemamill: ${reason(error)}\n`);
    return null;
  }
}

/** Whether an imported side carried an `error` diagnostic; a workspace side never does. */
function carriesError(imported: SidedModel): boolean {
  return imported.result !== null && hasErrors(imported.result.diagnostics);
}

/** The message of a thrown value, stringified when it is not an `Error`. */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
