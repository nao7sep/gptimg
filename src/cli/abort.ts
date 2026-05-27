/**
 * Process-wide AbortController for CLI invocations. SIGINT triggers
 * `abort()`; a second SIGINT inside the grace window forces an immediate
 * exit. The controller is installed once by `installSigintHandler` and the
 * signal is consumed by all CLI verb handlers.
 */
let controller: AbortController | null = null;
let secondSignalCount = 0;

const GRACE_MS = 2_000;

export function installSigintHandler(): AbortSignal {
  if (controller) return controller.signal;
  controller = new AbortController();
  process.on("SIGINT", () => {
    secondSignalCount += 1;
    if (secondSignalCount === 1) {
      controller?.abort(new Error("cancelled by SIGINT"));
      // Backstop: if nothing exits within the grace window, force exit so
      // a hung process can be killed by the user without a third Ctrl-C.
      setTimeout(() => process.exit(130), GRACE_MS).unref();
      return;
    }
    process.exit(130);
  });
  return controller.signal;
}

export function getAbortSignal(): AbortSignal | undefined {
  return controller?.signal;
}
