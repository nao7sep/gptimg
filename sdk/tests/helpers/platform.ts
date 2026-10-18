import { afterEach } from "vitest";

const actual = process.platform;

/**
 * Run the current test with `process.platform` reporting `platform`, so a
 * platform decision is exercised on any host; the real value returns after
 * each test. Only the reported name changes: the host's filesystem and
 * process semantics stay real.
 */
export function useReportedPlatform(): (platform: NodeJS.Platform) => void {
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: actual, configurable: true });
  });
  return (platform) => {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
  };
}
