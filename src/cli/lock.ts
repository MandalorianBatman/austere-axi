// One process writes a state dir's hub.db at a time: the server, or `feedback` when no
// server runs. Each keeps its copy of the sessions in memory, so two would overwrite
// each other's.
import fs from "node:fs";
import path from "node:path";
import { health } from "./client.ts";
import { VERSION } from "./paths.ts";
import type { ServerUnit, Supervisor } from "./service.ts";

// A process that has held the lock for less than this may still be starting (a server
// that does not answer on its port yet) or finishing (a command). Older and silent: it died.
const STARTING_MS = 60_000;

// How often the holder writes its lock again, so a live holder never ages out.
const REFRESH_MS = 15_000;

/** What server.lock holds: `{ pid, port?, at, supervised?, unit?, version? }`, or a bare pid (the old format); anything else when corrupt. */
type LockFile = { pid?: unknown; port?: unknown; at?: unknown; supervised?: unknown; unit?: unknown; version?: unknown } | number | null;

/**
 * A live holder of the lock. `serving`: a server that answered on its port. `supervised`: the service manager that runs it, and `unit`
 * the unit's name (a systemd unit, a launchd label; unknown for a lock written before locks named it).
 * `version`: the austere-axi version that holds it, unknown for a lock written before locks named one.
 */
export interface LockHolder {
  pid: number;
  port?: number;
  serving: boolean;
  supervised?: Supervisor;
  unit?: string;
  version?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Take the state dir's lock. A server passes its `port`; another process then asks that
 * port whether the server still runs, which a reused pid cannot fake. A server a service
 * manager runs passes its `unit`. `wait` is how long to wait for a holder that is
 * starting or finishing. Returns the function that lets go.
 */
export async function lockStateDir(
  dir: string,
  { port = null, wait = 0, unit = null }: { port?: number | null; wait?: number; unit?: ServerUnit | null } = {},
): Promise<() => void> {
  const file = path.join(dir, "server.lock");
  const deadline = Date.now() + wait;
  for (let stale = 0; stale < 3; ) {
    const lock = port ? { pid: process.pid, port, at: Date.now(), version: VERSION, ...(unit ? { supervised: unit.supervisor, unit: unit.unit } : {}) } : { pid: process.pid, at: Date.now(), version: VERSION };
    try {
      fs.writeFileSync(file, JSON.stringify(lock), { flag: "wx" });
      let held = true;
      // The holder keeps the lock fresh: a live server's lock must not look stale to the
      // next process, whatever the owner key does.
      const refresh = setInterval(() => {
        if (!held) return;
        try {
          const current = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: unknown };
          if (Number(current.pid) !== process.pid) return; // another process took it
          // Write and rename: a reader must never see a half-written lock and take it over.
          const tmp = `${file}.${process.pid}.tmp`;
          fs.writeFileSync(tmp, JSON.stringify({ ...lock, at: Date.now() }));
          fs.renameSync(tmp, file);
        } catch {
          // the file is gone or unreadable: the release will sort it out
        }
      }, REFRESH_MS);
      refresh.unref();
      return () => {
        if (!held) return;
        held = false;
        clearInterval(refresh);
        try {
          const current = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: unknown };
          if (Number(current.pid) === process.pid) fs.unlinkSync(file);
        } catch {
          // already gone
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const text = readFile(file);
    if (text == null) continue; // let go meanwhile
    const holder = await lockHolder(text, dir);
    if (!holder) {
      // Only remove the lock judged stale, not one another process took meanwhile.
      if (readFile(file) === text) fs.rmSync(file, { force: true });
      stale++;
      continue;
    }
    if (!holder.serving && Date.now() < deadline) {
      await sleep(100);
      continue;
    }
    if (holder.port) {
      throw new Error(`another austere-axi server (pid ${holder.pid}, port ${holder.port}) is using ${dir}; stop it first (\`austere-axi stop\`, with AUSTERE_AXI_PORT=${holder.port})`);
    }
    throw new Error(`another austere-axi process (pid ${holder.pid}) is using ${dir}; try again, or delete ${file} if that process is not austere-axi`);
  }
  throw new Error(`could not lock ${dir} (${file})`);
}

/** Who holds `dir`'s lock now, or null when no one does (a stale lock counts as none). */
export async function stateDirHolder(dir: string): Promise<LockHolder | null> {
  const text = readFile(path.join(dir, "server.lock"));
  return text == null ? null : lockHolder(text, dir);
}

function readFile(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * The port the server named in `dir`'s server.lock listens on, while the process that wrote it
 * lives and keeps the lock fresh (a server rewrites it every REFRESH_MS); null for no lock, a lock
 * without a port (a command holds it), a dead holder or a stale lock (a reused pid). Read without
 * asking the port, so a CLI can find a server another port than the default runs on.
 */
export function lockedPort(dir: string): number | null {
  let lock: LockFile;
  try {
    lock = JSON.parse(fs.readFileSync(path.join(dir, "server.lock"), "utf8")) as LockFile;
  } catch {
    return null;
  }
  if (!lock || typeof lock !== "object") return null;
  const pid = Number(lock.pid);
  const port = lock.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port >= 65536) return null;
  if (!(Date.now() - Number(lock.at) < STARTING_MS)) return null;
  return Number.isInteger(pid) && pid > 0 && processAlive(pid) ? port : null;
}

/**
 * Who holds the lock, or null when it is stale. A server that answers on the port in
 * the lock with the same pid and state dir holds it. A lock naming no port (a command,
 * or a server from before locks named one) or a server that does not answer yet holds
 * it while its pid is alive and, unless it is in the old format, for STARTING_MS.
 */
async function lockHolder(text: string, dir: string): Promise<LockHolder | null> {
  let lock: LockFile;
  try {
    lock = JSON.parse(text) as LockFile;
  } catch {
    return null;
  }
  // The old format: a bare pid.
  if (typeof lock === "number") lock = { pid: lock };
  const pid = Number(lock?.pid);
  if (!lock || !Number.isInteger(pid) || pid <= 0 || pid === process.pid) return null;
  const port = typeof lock.port === "number" && Number.isInteger(lock.port) && lock.port > 0 ? lock.port : undefined;
  const supervised = lock.supervised === "systemd" || lock.supervised === "launchd" ? lock.supervised : undefined;
  const unit = supervised && typeof lock.unit === "string" && lock.unit ? lock.unit : undefined;
  if (port) {
    // A server proves it holds this state dir's owner key (no key is sent) and is that pid on that dir.
    const h = await health(port);
    if (h && !h.foreign && h.pid === pid && h.stateDir === dir) return { pid, port, serving: true, supervised, unit, version: h.version };
  }
  if (!processAlive(pid)) return null;
  const version = typeof lock.version === "string" ? lock.version : undefined;
  // An old-format lock cannot be checked on a port. A live pid keeps it, as before: wrongly
  // taking a lock a server still holds would put two writers on hub.db, while wrongly
  // keeping one only blocks with a message that says to delete the file.
  if (lock.at == null) return { pid, port, serving: false };
  return Date.now() - Number(lock.at) < STARTING_MS ? { pid, port, serving: false, supervised, unit, version } : null;
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
