import { MAX_TARGET_VERSION, MIN_TARGET_VERSION } from '@schemamill/postgres';
import type { Command } from 'commander';

/** The accepted `--target-version` values: every declared major, as the flag's raw string. */
const TARGET_VERSIONS: ReadonlySet<string> = new Set(
  Array.from({ length: MAX_TARGET_VERSION - MIN_TARGET_VERSION + 1 }, (_, index) =>
    String(MIN_TARGET_VERSION + index),
  ),
);

/**
 * Validates the `--target-version` value shared by the rendering commands — `plan`'s migration
 * SQL and `export`'s DDL — against the package's declared 13–18 span. Anything else is a usage
 * error emitted through Commander, with the one pinned message both commands must print; call
 * it before any filesystem access so a bad flag never depends on what the disk holds.
 */
export function validateTargetVersion(command: Command, value: string): void {
  if (!TARGET_VERSIONS.has(value)) {
    command.error(
      `error: --target-version must be a PostgreSQL major from ${MIN_TARGET_VERSION} to ${MAX_TARGET_VERSION}`,
    );
  }
}
