// How the hub talks to /hub/api. The server answers only the owner (the cookie); this page holds no secret.
import type { ArchiveResult } from "../shared/hub-api.ts";

export class Refused extends Error {}

export async function get<T>(route: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(route, { headers: { accept: "application/json" }, signal });
  if (r.status === 403)
    throw new Refused(
      "This browser is not signed in as the owner. Run `austere-axi hub open` to sign in again.",
    );
  if (!r.ok) throw new Error(`austere-axi answered ${r.status}`);
  return (await r.json()) as T;
}

export async function post(route: string, body: object = {}): Promise<ArchiveResult | null> {
  try {
    const r = await fetch(route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return r.ok ? ((await r.json()) as ArchiveResult) : null;
  } catch {
    return null;
  }
}

export const UNREACHABLE =
  "Could not reach austere-axi. Check that it is still running, then reload.";
export const errorText = (err: unknown): string =>
  err instanceof Refused ? err.message : UNREACHABLE;

/** POST for Settings: the answer, or the server's error text (or why it could not be reached). */
export async function send<T>(
  route: string,
  body: object = {},
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  let r: Response;
  try {
    r = await fetch(route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: UNREACHABLE };
  }
  const data = (await r.json().catch(() => ({}))) as T & { error?: string };
  return r.ok
    ? { ok: true, data }
    : { ok: false, error: data.error || `austere-axi answered ${r.status}` };
}

export function query(params: Record<string, string>): string {
  const p = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== ""));
  const s = p.toString();
  return s ? `?${s}` : "";
}

export const openLink = (id: string, extra: Record<string, string> = {}): string =>
  `/hub/open/${id}${query(extra)}`;
