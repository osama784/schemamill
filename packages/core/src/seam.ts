/**
 * The dialect seam — the socket declared here, plugged by `@schemamill/postgres`.
 *
 * Shape only: this fixes where the boundary is and what crosses it, not the
 * payloads. The model, the diagnostics, the plan, and the hazards are type
 * parameters until the functional design settles their shape.
 */

/** What both inbound ports answer with: the model, with diagnostics beside it. */
export interface ReadResult<Model, Diagnostic> {
  readonly model: Model;
  readonly diagnostics: readonly Diagnostic[];
}

/** DDL text → the model, plus diagnostics. Import is a translation. */
export interface DdlImporter<Model, Diagnostic> {
  import(ddl: string): ReadResult<Model, Diagnostic>;
}

/** A read-only connection → the model, plus diagnostics. The verb is introspect. */
export interface CatalogReader<Connection, Model, Diagnostic> {
  introspect(connection: Connection): Promise<ReadResult<Model, Diagnostic>>;
}

/** A migration plan → migration SQL, deterministic. */
export interface SqlRenderer<Plan> {
  render(plan: Plan): string;
}

/** A migration plan → hazard annotations. Hazards belong to the plan. */
export interface HazardAnalyzer<Plan, Hazard> {
  analyze(plan: Plan): readonly Hazard[];
}
