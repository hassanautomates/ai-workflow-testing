/**
 * The harness itself can't do its job: a malformed workflow listing, a block
 * it doesn't know, a case it can't drive. Always fails the test; never means
 * "the app is wrong".
 */
export class HarnessError extends Error {
  override name = 'HarnessError';
}
