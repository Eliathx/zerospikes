/**
 * A synthetic regression for `scripts/sensitivity.mjs`: busy-waits on the main
 * thread for a set time on every event of a type, before the app's own handlers,
 * as if the code behind that interaction had become slower. Only in builds made
 * with VITE_SLOWDOWN='{"click": 30}' (event type → ms per event).
 */
export function installSlowdown(config: Record<string, number>): void {
  for (const [type, ms] of Object.entries(config)) {
    addEventListener(
      type,
      () => {
        const end = performance.now() + ms;
        while (performance.now() < end);
      },
      { capture: true, passive: true },
    );
  }
}
