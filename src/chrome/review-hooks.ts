import { useEffect, useState } from "react";

/** The time now, again every `every` ms: for a label that counts up ("4 min", "sending again in 2 s"). */
export function useNow(every = 30_000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), every);
    return () => window.clearInterval(t);
  }, [every]);
  return now;
}

/** A class on <html> while `on` holds: the page's CSS reads state from it (`is-archived`, `exploring`, `sheet-open`). */
export function useRootClass(name: string, on: boolean): void {
  useEffect(() => {
    document.documentElement.classList.toggle(name, on);
  }, [name, on]);
}
