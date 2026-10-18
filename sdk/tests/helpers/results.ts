/** A verb's completed result, or a test failure naming the refusal it returned instead. */
export function done<T extends { status: string }>(result: T): Extract<T, { status: "completed" }> {
  if (result.status !== "completed") throw new Error(`expected a completed result, got ${JSON.stringify(result)}`);
  return result as Extract<T, { status: "completed" }>;
}
