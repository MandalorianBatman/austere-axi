import { useEffect, useState } from "react";
import { errorText } from "./hub-http.ts";
import { useHub } from "./hub-store.ts";

/**
 * Load a view's data when `args` (what the URL asks for) or the store's `version` change. A load that is
 * still on its way when either moves again is aborted and its answer ignored. The old answer stays on
 * screen meanwhile, so a refresh keeps scroll and focus; it comes back with the `args` it answered.
 */
export function useLoad<A, T>(
  args: A,
  load: (args: A, signal: AbortSignal) => Promise<T>,
): { loaded: { args: A; data: T } | null; error: string | null } {
  const version = useHub((s) => s.version);
  const key = JSON.stringify(args);
  const [loaded, setLoaded] = useState<{ args: A; data: T } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const ctl = new AbortController();
    load(args, ctl.signal).then(
      (data) => {
        if (ctl.signal.aborted) return;
        setLoaded({ args, data });
        setError(null);
      },
      (err: unknown) => {
        if (!ctl.signal.aborted) setError(errorText(err));
      },
    );
    return () => ctl.abort();
    // `key` stands for `args`; `load` is a module-level function.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [key, version]);
  return { loaded, error };
}
