// The owner's credentials for a test server: the key header that /api/* needs, and the cookie a
// browser gets from a link the CLI opened. Loopback alone is not the owner.
import { OWNER_COOKIE, ownerKey } from "../src/cli/invites.js";

export function ownerHeaders(stateDir) {
  const key = ownerKey(stateDir);
  return { "x-austere-key": key, cookie: `${OWNER_COOKIE}=${key}` };
}
