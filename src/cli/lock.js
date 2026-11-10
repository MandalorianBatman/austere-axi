// @ts-check
// One process writes a state dir's hub.db at a time: the server, or `feedback` when no
// server runs. Each keeps its copy of the sessions in memory, so two would overwrite
// each other's.
import fs from "node:fs";
import path from "node:path";
import { request } from "./client.js";

// A process that has held the lock for less than this may still be starting (a server
// that does not answer on its port yet) or finishing (a command). Older and silent: it died.
const STARTING_MS = 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Take the state dir's lock. A server passes its `port`; another process then asks that
 * port whether the server still runs, which a reused pid cannot fake. `wait` is how long
 * to wait for a holder that is starting or finishing. Returns the function that lets go.
 * @param {string} dir
 * @param {{ port?: number | null, wait?: number }} [opts]
 */
export async function lockStateDir(dir, { port = null, wait = 0 } = {}) {
  const file = path.join(dir, "server.lock");
  const deadline = Date.now() + wait;
  for (let stale = 0; stale < 3; ) {
    const mine = JSON.stringify(port ? { pid: process.pid, port, at: Date.now() } : { pid: process.pid, at: Date.now() });
    try {
      fs.writeFileSync(file, mine, { flag: "wx" });
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        try {
          if (fs.readFileSync(file, "utf8") === mine) fs.unlinkSync(file);
        } catch {
          // already gone
        }
      };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
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

function readFile(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * Who holds the lock, or null when it is stale. A server that answers on the port in
 * the lock with the same pid and state dir holds it. A lock naming no port (a command,
 * or a server from before locks named one) or a server that does not answer yet holds
 * it while its pid is alive and, unless it is in the old format, for STARTING_MS.
 * @returns {Promise<{ pid: number, port?: number, serving: boolean } | null>}
 */
async function lockHolder(text, dir) {
  let lock;
  try {
    lock = JSON.parse(text);
  } catch {
    return null;
  }
  // The old format: a bare pid.
  if (typeof lock === "number") lock = { pid: lock };
  const pid = Number(lock?.pid);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return null;
  const port = Number.isInteger(lock.port) && lock.port > 0 ? lock.port : undefined;
  if (port && (await serves(port, pid, dir))) return { pid, port, serving: true };
  if (!processAlive(pid)) return null;
  // An old-format lock cannot be checked on a port. A live pid keeps it, as before: wrongly
  // taking a lock a server still holds would put two writers on hub.db, while wrongly
  // keeping one only blocks with a message that says to delete the file.
  if (lock.at == null) return { pid, port, serving: false };
  return Date.now() - Number(lock.at) < STARTING_MS ? { pid, port, serving: false } : null;
}

async function serves(port, pid, dir) {
  try {
    const r = await request("GET", "/api/health", undefined, { timeoutMs: 2000, port });
    return r.status === 200 && r.data?.name === "austere-axi" && r.data.pid === pid && r.data.stateDir === dir;
  } catch {
    return false;
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}
