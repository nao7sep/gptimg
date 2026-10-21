import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type LockedPackage = { resolved?: string; hasInstallScript?: boolean; link?: boolean; inBundle?: boolean };
type Lockfile = { packages: Record<string, LockedPackage> };

// npm matches registry approvals against the resolved tarball identity, not the
// install path or the package's own version. Keep each review exact and make a
// changed source require another decision, including optional platform packages.
function scriptIdentities(lock: Lockfile): string[] {
  return Object.entries(lock.packages).flatMap(([path, entry]) => {
    if (!path.includes("node_modules/") || !entry.hasInstallScript || entry.link || entry.inBundle) return [];
    const url = new URL(entry.resolved ?? "file:unresolved");
    const match = /(?:^|\/)((?:@[^/]+\/)?([^/]+))\/-\/\2-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\.tgz$/.exec(url.pathname);
    if (!/^https?:$/.test(url.protocol) || !match || url.search || url.hash) {
      throw new Error(`Review unsupported install-script source: ${path} (${entry.resolved ?? "unresolved"})`);
    }
    return [`${match[1]}@${match[3]}`];
  });
}

function policyProblems(policy: Record<string, boolean>, identities: string[]): string[] {
  const locked = new Set(identities);
  return [
    ...Object.keys(policy).filter((key) => !locked.has(key)).map((key) => `Not an exact locked script identity: ${key}`),
    ...[...locked].filter((key) => typeof policy[key] !== "boolean").map((key) => `Missing script decision: ${key}`),
  ];
}

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  allowScripts?: Record<string, boolean>;
};
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")) as Lockfile;
const identities = scriptIdentities(lock);

// These planted changes prove the contract fails when an update outlives review.
describe("install-script decisions", () => {
  it("decides every locked script source with an exact identity", () => {
    expect(policyProblems(manifest.allowScripts ?? {}, identities)).toEqual([]);
  });

  it("rejects missing, stale, name-only and ranged decisions", () => {
    const identity = identities[0]!;
    for (const key of [undefined, `${identity}-stale`, identity.slice(0, identity.lastIndexOf("@")), identity.replace(/@([^@]+)$/, "@^$1")]) {
      const policy = { ...manifest.allowScripts };
      const decision = policy[identity]!;
      delete policy[identity];
      if (key !== undefined) policy[key] = decision;
      expect(policyProblems(policy, identities).length).toBeGreaterThan(0);
    }
  });

  it("uses resolved scoped identity through aliases and nested installs", () => {
    const fixture = { packages: { "node_modules/parent/node_modules/alias": {
      hasInstallScript: true, name: "forged", version: "9.9.9",
      resolved: "https://registry.npmjs.org/@scope/native/-/native-1.2.3.tgz",
    } } };
    expect(scriptIdentities(fixture)).toEqual(["@scope/native@1.2.3"]);
    expect(policyProblems({ "@scope/native@1.2.3": false }, scriptIdentities(fixture))).toEqual([]);
    fixture.packages["node_modules/parent/node_modules/alias"].resolved = "https://registry.npmjs.org/@scope/native/-/native-1.2.4.tgz";
    expect(policyProblems({ "@scope/native@1.2.3": true }, scriptIdentities(fixture))).not.toEqual([]);
  });

  it("requires explicit review of sources without a registry identity", () => {
    for (const resolved of [undefined, "file:../native", "https://example.com/native.tgz"]) {
      expect(() => scriptIdentities({ packages: { "node_modules/native": { hasInstallScript: true, resolved } } })).toThrow("Review unsupported");
    }
  });
});
