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

export type Loaded<T> = { status: "loading" } | { status: "error" } | { status: "done"; data: T };

/**
 * GET `url` as JSON while the component is mounted. A new `url`, or leaving, aborts the load in flight, so an answer
 * to an earlier ask never replaces a later one. `null` asks for nothing.
 */
export function useFetchJson<T>(url: string | null): Loaded<T> {
  const [state, setState] = useState<{ url: string | null; result: Loaded<T> }>({
    url,
    result: { status: "loading" },
  });
  useEffect(() => {
    if (url === null) return;
    const ctl = new AbortController();
    fetch(url, { signal: ctl.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        return (await r.json().catch(() => ({}))) as T;
      })
      .then(
        (data) => {
          if (!ctl.signal.aborted) setState({ url, result: { status: "done", data } });
        },
        () => {
          if (!ctl.signal.aborted) setState({ url, result: { status: "error" } });
        },
      );
    return () => ctl.abort();
  }, [url]);
  // An answer belongs to the url it was asked for: after a change of url the old answer is not shown.
  return state.url === url ? state.result : { status: "loading" };
}
