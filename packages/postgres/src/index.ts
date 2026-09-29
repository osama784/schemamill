import { version as coreVersion } from '@schemamill/core';

/** The dialect this package speaks. */
export const dialect = 'postgres';

/** The schemamill version. */
export const version = '0.2.0';

/** Version of the core model package this adapter is built against. */
export const coreVersionUsed = coreVersion;

export { ddlImporter, importDump } from './import.ts';
export { renderSql, sqlRenderer } from './render.ts';
