/** Request-id helpers. Host requires ids matching /^[A-Za-z0-9_-]{1,64}$/. */

export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const METHOD_PATTERN = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*){1,2}$/;

export function isValidId(id: string): boolean {
  return ID_PATTERN.test(id);
}

export function isValidMethod(method: string): boolean {
  return METHOD_PATTERN.test(method);
}

/**
 * Monotonic call-id generator: c-1, c-2, ... Ids only need to be unique per
 * client instance (each client has its own pending-request map).
 */
export function createIdGenerator(prefix = 'c'): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}
