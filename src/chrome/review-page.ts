// What the owner can do to the page itself: share it with one person, archive it, bring it back.
import { BASE, UNREACHABLE, failure } from "./review-env.ts";
import { bannerText, showBanner } from "./review-banner.ts";
import { set } from "./review-store.ts";
import type { ArchivePlan, ShareOffer } from "./review-types.ts";

/** Opens the Share dialog: name, what it reaches, hold or auto; then the link with a Copy button (review-dialogs.tsx). */
export async function openShare(): Promise<void> {
  const r = await fetch(`${BASE}/share`).catch(() => null);
  if (!r) return showBanner(UNREACHABLE);
  if (!r.ok) return showBanner(`Could not share this page: ${await failure(r)}`);
  set({ ask: { kind: "share", offer: (await r.json()) as ShareOffer } });
}

/** Shows why archive or unarchive failed; the next attempt that works takes it away, and leaves any other banner alone. */
let archiveError = "";
function showArchiveError(text: string): void {
  archiveError = text;
  showBanner(text);
}
function clearArchiveError(): void {
  if (archiveError && bannerText() === archiveError) showBanner("");
  archiveError = "";
}

/** Resolves to null (cancel), false (this copy) or true (every copy). */
function askArchive(plan: ArchivePlan): Promise<boolean | null> {
  const { promise, resolve } = Promise.withResolvers<boolean | null>();
  set({ ask: { kind: "archive", plan, done: resolve } });
  return promise;
}

export async function archivePage(): Promise<void> {
  const r = await fetch(`${BASE}/archive`).catch(() => null);
  if (!r) return showArchiveError(UNREACHABLE);
  if (!r.ok) return showArchiveError(`Could not archive this page: ${await failure(r)}`);
  const every = await askArchive((await r.json()) as ArchivePlan);
  if (every === null) return;
  const done = await fetch(`${BASE}/archive`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ every }),
  }).catch(() => null);
  if (!done) return showArchiveError(UNREACHABLE);
  if (!done.ok) return showArchiveError(`Could not archive this page: ${await failure(done)}`);
  clearArchiveError();
}

export async function unarchivePage(): Promise<void> {
  const r = await fetch(`${BASE}/unarchive`, { method: "POST" }).catch(() => null);
  if (!r) return showArchiveError(UNREACHABLE);
  if (!r.ok) return showArchiveError(`Could not unarchive this page: ${await failure(r)}`);
  clearArchiveError();
}
