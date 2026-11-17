// The hub shell's JSON API (`/hub/api/*`, RLM-356): what the server (src/cli/hub-api.ts) sends the
// owner's hub (src/chrome/shell.ts) and the owner's review header (src/chrome/nav.ts). Types only:
// every route is the owner's, behind the owner cookie.

/** Who takes a page's unanswered notes: an agent polling it, the attached agent (in a run, or from the owner's next note), or nobody yet. */
export type Taker = "listening" | "attach_on" | "nobody";

/** The inbox group a page is in. A page that needs the owner is never in another group. */
export type Group = "needs_you" | "waiting_on_agent" | "quiet";

/** Which copies `pages` lists: opened for review and not archived, every copy, or archived ones. */
export type PagesView = "open" | "all" | "archived";

/** The last run of a copy, when it failed. */
export interface FailedRun {
  id: string;
  reason: string | null;
  ended_at: number | null;
}

/** One copy of a page: the file in one root (a worktree), with its own notes and history. */
export interface ShellCopy {
  id: string;
  file: string;
  root: string;
  /** The root's branch, else its folder's name. */
  label: string;
  title: string | null;
  updated_at: number;
  missing: boolean;
  archived: boolean;
  /** Only checked or patched, never opened for review. */
  checked: boolean;
  open: number;
  received: number;
  addressed: number;
  held: number;
  /** open + received + held */
  unanswered: number;
  /** The newest revision, 0 before the first. */
  rev: number;
  /** The newest revision the owner had the page open on, 0 when never. */
  viewed_rev: number;
  /** Revisions since the owner last looked: 0 when they saw the newest one, or never opened it. */
  changed: number;
  /** An agent is polling for this copy's notes. */
  listening: boolean;
  failed_run: FailedRun | null;
  /** Its last run is queued, waiting for its session, or running. */
  run_active: boolean;
}

/** One page (a path in a project) with its copies and the attention fields, computed on the server. */
export interface ShellPage {
  id: string;
  project_id: string;
  project: string;
  rel_path: string;
  title: string | null;
  updated_at: number;
  /** The newest of its last activity and its newest revision. */
  activity: number;
  /** The copy the title opens: the newest whose file is there, else the newest. */
  open_id: string;
  /** Chip order: copies with unanswered notes first, then one an agent listens on, then the newest. */
  copies: ShellCopy[];
  unanswered: number;
  addressed: number;
  held: number;
  /** The effective attach setting of the page (its copies share it). */
  attach: "on" | "off";
  /** Revisions since the owner looked, or held notes, or a failed run. */
  needs_you: boolean;
  /** Revisions since the owner looked, summed over copies. */
  changed: number;
  /** Copies whose last run failed. */
  failed: number;
  /** Unanswered notes the agent can take (open or received; held ones wait for the owner). */
  waiting_on_agent: boolean;
  /** Who takes them; null when nothing waits on an agent. `attach_on` means the attached agent: see `run_active`. */
  taker: Taker | null;
  /** A run is queued, waiting or running on a copy with such notes. With attach on and none, the owner's next note starts one. */
  run_active: boolean;
  group: Group;
}

/** How many pages each view of `pages` shows, for one project. */
export interface ViewCounts {
  open: number;
  everything: number;
  archived: number;
  /** Pages with a copy only checked, never opened for review, and not archived. */
  checked: number;
}

/** GET /hub/api/projects */
export interface ProjectSummary {
  id: string;
  name: string;
  /** Main root first. */
  roots: string[];
  /** An older project of the same repository: the command that merges them. */
  same_as: { id: string; name: string; merge: string } | null;
  /** Pages open for review (not archived), unanswered notes on them, and how many need the owner. */
  pages: number;
  unanswered: number;
  needs_you: number;
}

export interface ProjectsResponse {
  projects: ProjectSummary[];
}

/** GET /hub/api/pages?project=&view=open|all|archived */
export interface PagesResponse {
  view: PagesView;
  /** The project filtered on; `id` is empty when `?project=` matched nothing. Null for every project. */
  project: { id: string; name: string; ref: string } | null;
  pages: ShellPage[];
  counts: ViewCounts;
}

/** One unanswered item of a note, for the inbox. */
export interface NoteSummary {
  id: string;
  artifact_id: string;
  at: number;
  kind: string;
  target: string | null;
  text: string | null;
  status: string;
  /** "" for the owner. */
  author: string;
  label: string;
}

export interface InboxPage extends ShellPage {
  /** Its newest unanswered notes (at most 3), over every copy. */
  notes: NoteSummary[];
}

/** A copy whose last run failed. */
export interface InboxRun extends FailedRun {
  artifact_id: string;
  page_id: string;
  title: string;
}

/** GET /hub/api/inbox?project= : pages opened for review, not archived, by group; newest activity first in each. */
export interface InboxResponse {
  project: { id: string; name: string; ref: string } | null;
  needs_you: InboxPage[];
  waiting_on_agent: InboxPage[];
  quiet: InboxPage[];
  /** Reviewer notes held for the owner's release, over every page in the inbox. */
  held: number;
  failed_runs: InboxRun[];
}

/** A statement whose text matches a search. */
export interface PartHit {
  artifact_id: string;
  page_id: string | null;
  title: string | null;
  file: string;
  copy: string;
  statement: string;
  component: string;
  snippet: string;
}

/** GET /hub/api/search?q= : pages by title, path or project; parts by their text (the content index). */
export interface SearchResponse {
  q: string;
  pages: ShellPage[];
  parts: PartHit[];
}

/** GET /hub/api/page/<copy id>: what the review header and the quick switcher show for one copy. */
export interface CopySummary {
  id: string;
  title: string | null;
  file: string;
  rel_path: string;
  project: { id: string; name: string } | null;
  /** Every copy of the page opened for review (and this one), newest first. */
  copies: { id: string; label: string; missing: boolean; archived: boolean }[];
  unanswered: number;
  rev: number;
  viewed_rev: number;
  attach: "on" | "off";
}

/** One item of a note in the Notes view. */
export interface NoteRow extends NoteSummary {
  device_id: string | null;
  remote: boolean;
  title: string | null;
  file: string;
  project: string;
  project_id: string | null;
}

/** GET /hub/api/notes?q=&status=&project=&author=&device= */
export interface NotesResponse {
  notes: NoteRow[];
  /** Reviewer names with notes. */
  authors: string[];
  device: { id: string; name: string } | null;
  project: { id: string; name: string; ref: string } | null;
}

/** One agent run in the Runs view. */
export interface RunItem {
  id: string;
  kind: string;
  status: string;
  reason: string | null;
  harness: string | null;
  mode: string | null;
  started_at: number | null;
  ended_at: number | null;
  artifact_id: string | null;
  title: string | null;
  file: string | null;
}

/** GET /hub/api/runs?project= : the newest 100. */
export interface HubRunsResponse {
  runs: RunItem[];
  project: { id: string; name: string; ref: string } | null;
}

/**
 * POST /hub/api/page/<copy id>/archive and /unarchive, body `{ids?}`. Without ids: archive every open copy of the
 * page, or unarchive every archived one. With ids (copies of that page): exactly those, as Undo does with `ids` below.
 */
export interface ArchiveResult {
  ok: true;
  /** The copies it changed. */
  ids: string[];
}

// ── Settings (RLM-396): the owner's page for the local server. People uses /hub/api/people (src/cli/server.ts). ──

/**
 * An address the server answers on: this computer (loopback), Tailscale, the local network Settings switched on
 * (reviewers only), or one added at a terminal (`AUSTERE_AXI_HOST`, `--also-listen`).
 */
export interface ListenAddress {
  kind: "this_computer" | "tailscale" | "local_network" | "added";
  host: string;
  url: string;
}

/**
 * Settings → Network → Local network (RLM-399): the address switched on (null: off, the default), whether the server
 * listens there now and at which URL, and this computer's local-network addresses.
 */
export interface LocalNetwork {
  address: string | null;
  listening: boolean;
  url: string | null;
  choices: { address: string; iface: string }[];
}

/** How the server stays up: a service runs it (`server install`), it was started to stay on, or it stops after `idle_minutes` without use. */
export interface AlwaysOn {
  mode: "service" | "kept_on" | "idles";
  supervisor: "systemd" | "launchd" | null;
  /** The systemd unit or launchd label that runs it. */
  unit: string | null;
  idle_minutes: number | null;
}

/** A page someone has open now, and who: the owner's tabs and reviewers' devices, by name. */
export interface PageViewers {
  id: string;
  title: string;
  file: string;
  viewers: { name: string; role: "owner" | "reviewer" }[];
}

/** GET /hub/api/settings */
export interface SettingsResponse {
  network: {
    port: number;
    addresses: ListenAddress[];
    /** The address links for teammates and phones use, and what set it; null: only this computer listens, so no link can be shared. */
    share: { url: string; from: "link_url" | "link_host" | "tailscale" | "host" | "lan" } | null;
    /** This machine on Tailscale, as Tailscale said last; null: Tailscale is not running here (or is turned off for this server). */
    tailscale: { ip: string; dns_name: string | null } | null;
    /** Whether the server listens on the tailnet, so `tailscale whois` names who comes in over it (RLM-399). */
    tailscale_names: boolean;
    lan: LocalNetwork;
    always_on: AlwaysOn;
  };
  review: {
    /** A new reviewer's notes go straight to the agent (true) or wait for the owner (false, the default). */
    auto: boolean;
    viewing: PageViewers[];
  };
  /** Copies opened for review whose file is gone: what "Archive missing pages" puts away. */
  missing: number;
  /** Project folders (roots) that are gone from disk: forgetting one archives its pages (`project forget-root --drop`). */
  gone_folders: string[];
  about: {
    version: string;
    state_dir: string;
    /** The newest CLI that called this server, when it is newer than the server; null otherwise. */
    newer_cli: string | null;
  };
}

/**
 * POST /hub/api/settings/review {auto}; POST /hub/api/projects/<id>/rename {name}, /merge {from} (`from`'s roots and
 * pages move into <id>), /forget-root {root, drop?}; POST /hub/api/projects/archive-missing {project?}.
 * `message`: what changed, in words, for the page's status line.
 */
export interface ProjectActionResult {
  ok: true;
  message: string;
}
