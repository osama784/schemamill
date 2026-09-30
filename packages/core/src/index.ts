/** The schemamill version. */
export const version = '0.3.0';

export { diff } from './diff.ts';
export { canonicalIntType, effectiveIdentity } from './identity.ts';
export { plan } from './plan.ts';
export {
  defaultSequenceMax,
  defaultSequenceMin,
  effectiveSequence,
  sequenceTypeBounds,
  sequenceTypeChange,
} from './sequence.ts';
export type * from './diagnostic.ts';
export type * from './diff.ts';
export type * from './identity.ts';
export type * from './model.ts';
export type * from './plan.ts';
export type * from './seam.ts';
export type * from './sequence.ts';
