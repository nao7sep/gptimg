/** Only the configured development document may navigate in place. */
export function navigationAllowed(candidate: string, developmentUrl: string | undefined): boolean {
  if (!developmentUrl) return false;
  try {
    const target = new URL(candidate);
    const trusted = new URL(developmentUrl);
    return target.username === "" && target.password === "" && target.origin === trusted.origin && target.pathname === trusted.pathname;
  } catch { return false; }
}
