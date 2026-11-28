import { version as coreVersion } from '@schemamill/core';

/** The dialect this package speaks. */
export const dialect = 'postgres';

/** The schemamill version. */
export const version = '0.7.0';

/** Version of the core model package this adapter is built against. */
export const coreVersionUsed = coreVersion;

export { analyzeHazards, hazardAnalyzer } from './hazards.ts';
export { catalogReader } from './catalog.ts';
export {
  collectDeclarationFacts,
  COMPRESSION_DECLARATION_MIN_MAJOR,
  NOT_NULL_DECLARATION_MIN_MAJOR,
} from './declaration-facts.ts';
export type {
  DeclarationFact,
  DeclarationFactOptions,
  DeclarationForm,
} from './declaration-facts.ts';
export {
  collectBaselineClaims,
  collectNameClaims,
  nameClaimIdentity,
  nameClaimKey,
  releasedBaselineKeys,
} from './name-claims.ts';
export type {
  ConstraintClaimDetail,
  ConstraintNameClaim,
  IndexNameClaim,
  NameClaim,
  NameClaimOptions,
  NameClaimPolarity,
} from './name-claims.ts';
export { ddlImporter, importDump } from './import.ts';
export {
  assertDeclarationsSupported,
  MAX_TARGET_VERSION,
  MIN_TARGET_VERSION,
  RenderRefusalError,
  renderSql,
  sqlRenderer,
} from './render.ts';
export type { RenderOptions } from './render.ts';
