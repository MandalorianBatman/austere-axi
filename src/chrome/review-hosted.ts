// A hosted page (austere-cloud, docs/sync-protocol.md): a reviewer's page that has
// no owner controls. It trades its invite for a frame token, then syncs over the page's WebSocket instead of the local
// event stream; notes go out through the outbox (review-outbox.ts).
import { SYNC_VERSION, syncProtocols } from "../shared/sync.ts";
import type { PageRow, ReceivedChanges, ReceivedFrame } from "../shared/sync.ts";
import { LOADER_TAG, packedTag } from "../shared/standalone.ts";
import { openSyncSocket } from "./sync-socket.ts";
import type { SyncClose } from "./sync-socket.ts";
import { BASE, BOOT, HOSTED, LS, NAME_MAX, SID } from "./review-env.ts";
import { reload, showBanner } from "./review-banner.ts";
import type { BannerAction } from "./review-banner.ts";
import { getFrame } from "./review-bridge.ts";
import { getSync, mine, refreshPending, sendWhenDue, setSync, settle } from "./review-outbox.ts";
import { getRoster } from "./review-presence.ts";
import { S, set } from "./review-store.ts";
import { mergeEntries } from "./review-transcript.ts";
import type { Entry } from "./review-types.ts";

// Hosted pages are invite-only by default (Q16). An invite link carries its token in the fragment,
// `#i=<token>`, which never reaches the server: keep it for this page and take it out of the address
// bar. Same-origin calls send it as X-Austere-Invite, the socket as a subprotocol.
const INVITE_KEY = `austere:invite:${SID}`;
const TOKEN = /^[A-Za-z0-9_-]{16,256}$/;
let invite: string | null = null;
if (HOSTED) {
  const fromLink = new URLSearchParams(location.hash.slice(1)).get("i");
  if (fromLink !== null) history.replaceState(null, "", location.pathname + location.search);
  if (fromLink !== null && TOKEN.test(fromLink)) {
    // The link's token is used as given; storing it only lets a reload without the fragment reuse it.
    invite = fromLink;
    LS.set(INVITE_KEY, fromLink);
  } else {
    const stored = LS.get<unknown>(INVITE_KEY, null);
    invite = typeof stored === "string" && TOKEN.test(stored) ? stored : null;
  }
  // Another invite link opened in this tab changes only the fragment, so the page does not load
  // again by itself: reload, keeping the fragment, so the intake above takes it (and strips it).
  window.addEventListener("hashchange", () => {
    if (new URLSearchParams(location.hash.slice(1)).has("i")) location.reload();
  });
}

/** The invite this page uses, for a request that must carry it (the report). */
export const getInvite = (): string | null => invite;

// The page row's publishedAt the shell was built for; a later one offers a reload.
let publishedAt = HOSTED?.publishedAt;
// Highest row seq applied, kept for the tab: a reconnect pulls after it.
let cursor = 0;
// The service let this browser in on the owner's sign-in cookie (`publish login`), not an invite.
let ownerView = false;

/** Nothing more can be sent: say why in the presence label and the banner, and stop syncing. */
function lock(label: string, message: string, actions: BannerAction[] = []): void {
  set({ lockout: label, connected: false });
  getSync()?.stop();
  showBanner(message, actions);
}

/** Locks on an answer that means this reviewer cannot get in (403) or the page is gone (404, 410). */
function refused(status: number): boolean {
  if (status === 403) {
    // The service's account sign-in (same origin, a plain navigation); it brings the viewer back to this page.
    const signIn =
      typeof HOSTED?.signIn === "string" &&
      HOSTED.signIn.startsWith("/") &&
      !HOSTED.signIn.startsWith("//")
        ? HOSTED.signIn
        : null;
    const actions: BannerAction[] = signIn ? [{ label: "Sign in", href: signIn }] : [];
    const orSignIn = signIn ? " Or sign in with the account the owner shared it with." : "";
    if (ownerView)
      lock(
        "Signed out",
        `Your owner sign-in has expired. ${signIn ? "Sign in again, or run" : "Run"} \`austere-axi publish login <file>\` for a new link.`,
        actions,
      );
    else if (invite)
      lock(
        "Invite no longer valid",
        `This invite is no longer valid. Ask the page owner for a new link.${orSignIn}`,
        actions,
      );
    else
      lock(
        "Invite required",
        `This page is invite-only. Open it from the link the page owner sent you.${orSignIn}`,
        actions,
      );
  } else if (status === 404 || status === 410)
    lock("Page removed", "This page is no longer available.");
  else return false;
  return true;
}

/**
 * POST {base}/asset-token: trades the invite (none on an unlisted page) or the owner's sign-in
 * cookie for a 10-minute frame token, the page title and who the viewer is.
 */
async function requestAssetToken(signal?: AbortSignal): Promise<{
  status: number;
  token?: string;
  name?: string | null;
  title?: string;
  owner?: boolean;
}> {
  const r = await fetch(`${BASE}/asset-token`, {
    method: "POST",
    headers: invite ? { "X-Austere-Invite": invite } : {},
    signal,
  });
  if (!r.ok) return { status: r.status };
  const d = (await r.json().catch(() => null)) as {
    token?: unknown;
    name?: unknown;
    title?: unknown;
    owner?: unknown;
  } | null;
  const token =
    typeof d?.token === "string" && /^[A-Za-z0-9_-]+$/.test(d.token) ? d.token : undefined;
  return {
    status: r.status,
    token,
    name: typeof d?.name === "string" && d.name ? d.name.slice(0, NAME_MAX) : null,
    title: typeof d?.title === "string" && d.title ? d.title : undefined,
    owner: d?.owner === true,
  };
}

/** Loads the frame from `${artifactUrl}<assetToken>/` and learns who the reviewer is. */
export async function loadHostedFrame(): Promise<boolean> {
  const answer = await requestAssetToken().catch(() => null);
  if (answer && refused(answer.status)) return false;
  if (!answer?.token) {
    showBanner(`Could not load this page${answer ? ` (HTTP ${answer.status})` : ""}.`, [
      { label: "Retry", onClick: () => void startHosted() },
    ]);
    return false;
  }
  if (typeof answer.title === "string" && answer.title.trim()) set({ title: answer.title.trim() });
  ownerView = !!answer.owner;
  const inviteName = answer.name ?? null;
  if (inviteName) set({ inviteName, viewerName: inviteName });
  else {
    // An unlisted page answered without a name: the stored invite is not valid here, so stop sending it.
    if (invite) {
      invite = null;
      LS.remove(INVITE_KEY);
    }
    set({
      inviteName,
      viewerName: String(LS.get("austere:name", "") || "").slice(0, NAME_MAX),
    });
  }
  // The notes waiting for an ack are the ones of the reviewer this page now is.
  refreshPending();
  const frame = getFrame();
  if (frame) frame.src = `${BOOT.artifactUrl ?? `${BASE}/a/`}${answer.token}/`;
  return true;
}

/** Base64 of `bytes`, in chunks (spreading a whole runtime into fromCharCode overflows the stack). */
function base64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function gzipBase64(code: string): Promise<string> {
  const stream = new Blob([code]).stream().pipeThrough(new CompressionStream("gzip"));
  return base64(new Uint8Array(await new Response(stream).arrayBuffer()));
}

// The published page's script tags: the pinned runtime and bundled packs (/rt/), and installed packs
// (/pk/). The service refuses any other `src`, so these are all the page runs.
const HOSTED_SCRIPT_RE =
  /<script\b[^>]*\bsrc\s*=\s*["'](\/(?:rt|pk)\/[^"']+)["'][^>]*>\s*<\/script\s*>/gi;

/**
 * Hosted "Download standalone HTML": the published page with its scripts packed in, in the format
 * `export` writes (src/shared/standalone.ts), so it opens offline. Images are already inlined by `publish`.
 */
export async function downloadStandalone(): Promise<void> {
  if (S().exporting) return;
  set({ exporting: true });
  let url: string | undefined;
  try {
    const answer = await requestAssetToken();
    if (!answer.token) throw new Error(`HTTP ${answer.status}`);
    const r = await fetch(`${BOOT.artifactUrl ?? `${BASE}/a/`}${answer.token}/`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const html = await r.text();
    const tags = [...html.matchAll(HOSTED_SCRIPT_RE)];
    if (!tags.length) throw new Error("the page has no runtime script");
    const packed = await Promise.all(
      tags.map(async (m) => {
        const s = await fetch(m[1]);
        if (!s.ok) throw new Error(`${m[1]}: HTTP ${s.status}`);
        return packedTag(m[1].replace(/^\/rt\/[^/]+\//, ""), await gzipBase64(await s.text()));
      }),
    );
    // All blocks and the loader where the first tag was: the runtime first, then the packs, in page order.
    let i = 0;
    const out = html.replace(HOSTED_SCRIPT_RE, () =>
      i++ ? "" : [...packed, LOADER_TAG].join("\n"),
    );
    url = URL.createObjectURL(new Blob([out], { type: "text/html" }));
    const slug =
      S()
        .title.replace(/[^\p{L}\p{N}]+/gu, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80) || "page";
    // In the document while clicked: Firefox ignores a click on a detached download anchor.
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slug}.html`;
    a.hidden = true;
    document.body.append(a);
    a.click();
    a.remove();
  } catch (err) {
    showBanner(`Could not build the download: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    // Late enough for the browser to have read the blob, on every path that made one.
    if (url) setTimeout(URL.revokeObjectURL, 60_000, url);
    set({ exporting: false });
  }
}

/** Applies rows as upserts by (type, id), then stores the cursor. */
function applyChanges(changes: ReceivedChanges): void {
  if (changes.reset) set({ transcript: [] });
  const entries: Entry[] = [];
  for (const row of changes.rows) {
    if (row.type === "page") applyPage(row);
    // Reviewers see notes in every state; discarded ones are hidden.
    else if (row.type === "note")
      entries.push({
        id: `note:${row.id}`,
        role: "user",
        author: row.author.slice(0, NAME_MAX),
        items: row.items,
        at: row.at,
        discarded: row.state === "discarded",
      });
    else if (row.type === "reply")
      entries.push({ id: `reply:${row.id}`, role: "agent", text: row.text, at: row.at });
  }
  mergeEntries(entries);
  cursor = changes.cursor;
  set({ loaded: true });
}

function applyPage(row: PageRow): void {
  // The server closes the socket (1000) after a deleted page's row.
  if (row.deleted) return lock("Page removed", "The owner removed this page.");
  publishedAt ??= row.publishedAt;
  if (row.publishedAt !== publishedAt) showBanner("New version, reload", [reload()]);
  // Sharing follows the page, not the viewer: on an unlisted page the plain URL lets anyone in, so every
  // viewer (invited or not) may copy it; on an invite-only page each link names one reviewer, so the menu
  // says how the owner invites someone instead.
  set({ packs: row.packs.map((p) => p.name), unlisted: row.unlisted });
}

function onSyncFrame(frame: ReceivedFrame): void {
  if (frame.t === "changes") applyChanges(frame);
  else if (frame.t === "ack") settle(frame);
  // `forbidden` and `upgrade_required` come before the server closes the socket: onSyncClose says why.
  else if (frame.t === "error" && frame.code !== "forbidden" && frame.code !== "upgrade_required")
    set({ composerError: frame.message });
}

function onSyncClose(close: SyncClose, retrying: boolean): void {
  set({ connected: false });
  if (!retrying && !S().lockout) {
    if (close.error?.code === "upgrade_required") {
      lock("Update needed", "This page needs a newer review page. Reload to get it.", [reload()]);
    } else if (close.code === 1000 && !close.error)
      lock("Page removed", "This page is no longer available.");
    // `forbidden` and close 1008: the invite was revoked or expired, or the page is no longer unlisted.
    else refused(403);
  }
}

const RETRY_CHECK_MS = 5_000;

/**
 * Hosted boot: trade for the frame's token, then open the page socket. It carries the rows, the
 * note mutations and presence (the server sends no presence on a --no-presence page).
 */
export async function startHosted(): Promise<void> {
  showBanner("");
  if (!(await loadHostedFrame()) || getSync()) return;
  const socket = openSyncSocket({
    url: `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${BASE}/sync`,
    protocols: () => syncProtocols(invite ? { invite } : {}),
    // A refused handshake shows no status to the page: ask the asset-token route why.
    mayRetry: async (close) => {
      if (S().lockout) return false;
      if (close.opened) return true;
      // A stalled check must not hold up the next attempt: past 5 s it counts as offline, and the socket retries.
      const answer = await requestAssetToken(AbortSignal.timeout(RETRY_CHECK_MS)).catch(() => null);
      return !(answer && refused(answer.status));
    },
  });
  setSync(socket);
  socket.onOpen(() => {
    set({ connected: true });
    socket.send({ v: SYNC_VERSION, t: "pull", after: cursor });
    // Unacked notes go again, in order; the server answers a repeat (clientId, n) with the same ack.
    for (const o of mine()) sendWhenDue(o);
  });
  socket.onFrame(onSyncFrame);
  socket.onClose(onSyncClose);
  socket.onOpen(() => getRoster()?.connect((frame) => void socket.send(frame)));
  socket.onFrame((f) => {
    if (f.t === "hello" || f.t === "status" || f.t === "focus" || f.t === "bye")
      getRoster()?.handle(f);
  });
  socket.onClose(() => getRoster()?.disconnect());
}
