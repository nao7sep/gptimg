/**
 * Run `fn` with `process.stderr.write` swapped for a capturing stub, returning
 * every chunk it wrote (decoded to strings). Restores the real writer even if
 * `fn` throws — so a failing assertion inside `fn` never leaks the patch into
 * the rest of the suite.
 */
export async function captureStderr(fn: () => Promise<void>): Promise<string[]> {
  const chunks: string[] = [];
  const real = process.stderr.write;
  process.stderr.write = ((c: unknown) => {
    chunks.push(typeof c === "string" ? c : Buffer.from(c as Uint8Array).toString("utf-8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = real;
  }
  return chunks;
}
