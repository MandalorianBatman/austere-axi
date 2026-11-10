// The owner's credentials for a test server: the key header that /api/* needs, and the cookie a
// browser gets from a login code or the owner's remote link (derived from the key, not the key).
// Loopback alone is not the owner.
import { OWNER_COOKIE, ownerCookie, ownerKey } from "../src/cli/invites.js";

export function ownerHeaders(stateDir) {
  const key = ownerKey(stateDir);
  return { "x-austere-key": key, cookie: `${OWNER_COOKIE}=${ownerCookie(key)}` };
}
