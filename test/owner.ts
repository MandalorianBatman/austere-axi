// The owner's credentials for a test server: the key header that /api/* needs, and the cookie a
// browser gets from a login code or the owner's remote link (derived from the key, not the key).
// Loopback alone is not the owner.
import http from "node:http";
import { COOKIE, OWNER_COOKIE, ownerCookie, ownerKey } from "../src/cli/invites.ts";

export function ownerHeaders(stateDir: string): { "x-austere-key": string; cookie: string } {
  const key = ownerKey(stateDir);
  return { "x-austere-key": key, cookie: `${OWNER_COOKIE}=${ownerCookie(key)}` };
}

/**
 * Open a share link as a browser would and claim it: the confirmation form's same-origin POST.
 * Returns the reviewer's Cookie header (the device secret the server set, never the link token).
 */
export function claimLink(port: number, link: string): Promise<string> {
  const u = new URL(link);
  const id = /^\/s\/([a-f0-9]{12})/.exec(u.pathname)?.[1];
  const token = u.searchParams.get("invite");
  if (!id || !token) throw new Error(`not a share link: ${link}`);
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const r = http.request(
    {
      host: "127.0.0.1",
      port,
      method: "POST",
      path: `/s/${id}/join`,
      headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "content-type": "application/x-www-form-urlencoded" },
    },
    (res) => {
      res.resume();
      res.on("end", () => {
        const set = (res.headers["set-cookie"] ?? []).find((c) => c.startsWith(`${COOKIE}_`));
        if (res.statusCode !== 303 || !set) return reject(new Error(`join refused: ${res.statusCode}`));
        resolve(set.split(";")[0]);
      });
    },
  );
  r.on("error", reject);
  r.end(new URLSearchParams({ invite: token }).toString());
  return promise;
}
