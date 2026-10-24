import { useEffect, useRef } from "react";

/**
 * Live readout of what zerospikes measures in tests: input to next frame for the
 * last gesture, and the worst frame of the last two seconds. Writes the DOM
 * directly a few times a second so the meter itself doesn't cost frames.
 */
export function Hud() {
  const inputRef = useRef<HTMLSpanElement>(null);
  const frameRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let running = true;
    let gestureLatency = 0;
    let lastInputAt = 0;
    // Frame start times and durations of the last two seconds.
    const frames: { at: number; ms: number }[] = [];
    let previousFrame = performance.now();
    let lastUpdate = 0;

    const show = (el: HTMLElement | null, ms: number) => {
      if (!el) return;
      el.textContent = ms ? `${ms.toFixed(0)} ms` : "—";
      el.dataset.tone = ms > 100 ? "bad" : ms > 34 ? "warn" : "ok";
    };

    const onFrame = (now: number) => {
      if (!running) return;
      frames.push({ at: now, ms: now - previousFrame });
      previousFrame = now;
      while (frames.length && now - frames[0].at > 2000) frames.shift();
      if (now - lastUpdate > 250) {
        lastUpdate = now;
        show(frameRef.current, Math.max(...frames.map((f) => f.ms)));
        show(inputRef.current, gestureLatency);
      }
      requestAnimationFrame(onFrame);
    };
    requestAnimationFrame(onFrame);

    const onInput = (e: Event) => {
      const createdAt = e.timeStamp;
      requestAnimationFrame(() =>
        setTimeout(() => {
          const ms = performance.now() - createdAt;
          // One gesture = inputs closer than 500 ms apart; show its worst.
          gestureLatency = createdAt - lastInputAt < 500 ? Math.max(gestureLatency, ms) : ms;
          lastInputAt = createdAt;
        }, 0),
      );
    };
    const types = ["pointerdown", "pointermove", "pointerup", "keydown", "wheel"];
    for (const type of types) addEventListener(type, onInput, { capture: true, passive: true });
    return () => {
      running = false;
      for (const type of types) removeEventListener(type, onInput, { capture: true });
    };
  }, []);

  return (
    <div className="hud" aria-label="Live meter">
      <div>
        <small>input to frame</small>
        <span ref={inputRef}>—</span>
      </div>
      <div>
        <small>worst frame (2 s)</small>
        <span ref={frameRef}>—</span>
      </div>
    </div>
  );
}
