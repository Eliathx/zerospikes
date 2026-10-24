// Functions passed to page.evaluate(): Playwright sends their source to the page,
// so they must stay self-contained (no imports, no closures over module scope).

export interface RawRecording {
  /** Timestamp of every animation frame while recording. */
  frames: number[];
  /** Time from each input event to the frame after it. */
  inputs: { type: string; ms: number }[];
  /** null when the browser has no Long Animation Frames API. */
  longFrames: { duration: number; scripts: string[] }[] | null;
}

/** Installs the recorder once per document and starts a recording window. */
export function startRecording(): void {
  const global = window as any;
  if (!global.__zerospikes) {
    const recorder = {
      recording: false,
      startedAt: 0,
      frames: [] as number[],
      inputs: [] as { type: string; ms: number }[],
      longFrames: [] as { start: number; duration: number; scripts: string[] }[],
      /** Input timings still waiting for their frame. */
      pending: 0,
      longFramesSupported: false,
    };
    global.__zerospikes = recorder;
    // Input → next frame: a capture listener on window runs before the app's own
    // handlers; the rAF it queues runs after them and after style/layout, and the
    // setTimeout after that lands once the frame has been produced. Works for
    // continuous events (pointermove, wheel) that Event Timing leaves out.
    for (const type of ["pointerdown", "pointermove", "pointerup", "click", "keydown", "wheel"]) {
      addEventListener(
        type,
        (event) => {
          if (!recorder.recording) return;
          const createdAt = event.timeStamp;
          recorder.pending++;
          requestAnimationFrame(() =>
            setTimeout(() => {
              recorder.inputs.push({ type, ms: performance.now() - createdAt });
              recorder.pending--;
            }, 0),
          );
        },
        { capture: true, passive: true },
      );
    }
    if (PerformanceObserver.supportedEntryTypes?.includes("long-animation-frame")) {
      recorder.longFramesSupported = true;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as any[]) {
          recorder.longFrames.push({
            start: entry.startTime,
            duration: entry.duration,
            scripts: (entry.scripts ?? []).map((script: any) => {
              const file = String(script.sourceURL ?? "").split("/").pop()?.split("?")[0] ?? "";
              const fn = script.sourceFunctionName || script.invoker || "(anonymous)";
              return file ? `${fn} @ ${file}` : fn;
            }),
          });
        }
      }).observe({ type: "long-animation-frame" });
    }
  }
  const recorder = global.__zerospikes;
  recorder.frames = [];
  recorder.inputs = [];
  recorder.longFrames = [];
  recorder.pending = 0;
  recorder.startedAt = performance.now();
  recorder.recording = true;
  const onFrame = (timestamp: number) => {
    if (!recorder.recording) return;
    recorder.frames.push(timestamp);
    requestAnimationFrame(onFrame);
  };
  requestAnimationFrame(onFrame);
}

/** Keeps recording for `settleMs`, waits for pending input timings, then stops. */
export async function finishRecording(settleMs: number): Promise<RawRecording> {
  const recorder = (window as any).__zerospikes;
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  const deadline = performance.now() + 5000;
  while (recorder.pending > 0 && performance.now() < deadline) {
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
  }
  recorder.recording = false;
  // Long animation frames are reported asynchronously; give the observer a task to flush.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return {
    frames: recorder.frames,
    inputs: recorder.inputs,
    longFrames: recorder.longFramesSupported
      ? recorder.longFrames
          .filter((frame: { start: number }) => frame.start >= recorder.startedAt)
          .map((frame: { duration: number; scripts: string[] }) => ({ duration: frame.duration, scripts: frame.scripts }))
      : null,
  };
}

/** Resolves on the next animation frame. */
export function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
