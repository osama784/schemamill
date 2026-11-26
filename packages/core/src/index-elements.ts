import type { IndexElement } from './model.ts';

/**
 * The one canonical serialization of an index element: a plain column is its name; an
 * expression is `JSON.stringify({ expression })`, so a column named `{"expression":"x"}` cannot
 * collide with that expression. Every identity, equality, structure key, and display join goes
 * through here, so authored order is the only order the model knows.
 */
export function serializeIndexElement(element: IndexElement): string {
  return typeof element === 'string' ? element : JSON.stringify({ expression: element.expression });
}

/** The fixed separator of the ordered element key; PostgreSQL identifiers cannot hold a NUL. */
const ELEMENT_SEPARATOR = '\u0000';

/** The canonical key of an ordered element list: each serialized element joined by NUL. */
export function indexElementsKey(elements: readonly IndexElement[]): string {
  return elements.map(serializeIndexElement).join(ELEMENT_SEPARATOR);
}

/**
 * The element-wise order over canonical serializations, with a shorter list first when one is a
 * prefix of the other. Authored order is semantic, so an element swap is a real difference.
 */
export function compareIndexElements(
  left: readonly IndexElement[],
  right: readonly IndexElement[],
): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const leftElement = serializeIndexElement(left[index]!);
    const rightElement = serializeIndexElement(right[index]!);
    if (leftElement < rightElement) return -1;
    if (leftElement > rightElement) return 1;
  }
  return left.length - right.length;
}

/**
 * Whether two ordered element lists serialize identically. Shared by structural equality in
 * core and by the two importers' structure keys so they cannot disagree on identity.
 */
export function sameIndexElements(
  left: readonly IndexElement[],
  right: readonly IndexElement[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (element, index) => serializeIndexElement(element) === serializeIndexElement(right[index]!),
    )
  );
}
