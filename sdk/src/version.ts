import manifest from "../package.json" with { type: "json" };

/**
 * The SDK's own version, for a caller that needs to know which gptimgsdk it
 * holds: read from the SDK's own package.json, never written as a literal
 * (sdk-conventions). A JSON import runs on plain Node and bundles with the
 * app's build, which inlines it.
 */
export const VERSION: string = manifest.version;
