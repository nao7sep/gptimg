// Continuous editing, such as stepping a splitter with the keyboard, saves a
// short delay after the last step, and each step pushes the save back. A value
// still waiting is saved at once when focus leaves or the window goes away.
import { useCallback, useEffect, useRef } from "react";

const DELAY_MS = 500;

export function useSettledSave<T>(save: (value: T) => void): { push: (value: T) => void; flush: () => void } {
  const saveRef = useRef(save);
  saveRef.current = save;
  const pending = useRef<{ value: T } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    const waiting = pending.current;
    pending.current = null;
    if (waiting) saveRef.current(waiting.value);
  }, []);

  const push = useCallback((value: T) => {
    pending.current = { value };
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, DELAY_MS);
  }, [flush]);

  useEffect(() => {
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [flush]);

  return { push, flush };
}
