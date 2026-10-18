/**
 * The SDK's own version, for a caller that needs to know which gptimgsdk it
 * holds. Kept here rather than read from package.json so a bundled app never
 * reaches outside `src`; tests/version.test.ts holds it equal to
 * package.json's version.
 */
export const VERSION = "0.1.0";
