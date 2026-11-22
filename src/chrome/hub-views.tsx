// The hub's views: Inbox · Pages · Notes · Runs · Search. Each reads its own data (/hub/api) in an effect
// and draws it; the URL's filters come from the store.
import type { ReactElement, ReactNode } from "react";
import type {
  HubRunsResponse,
  InboxPage,
  InboxResponse,
  NoteRow,
  NotesResponse,
  PagesResponse,
  PagesView,
  PartHit,
  RunItem,
  SearchResponse,
  ShellPage,
} from "../shared/hub-api.ts";
import { basename, joinText, middle, plural, titleOf, when } from "./format.ts";
import { tilde } from "./hub-env.ts";
import { get, openLink, query } from "./hub-http.ts";
import { useLoad } from "./hub-load.ts";
import {
  ArchiveButton,
  Chips,
  Empty,
  PageRow,
  ProjectFilter,
  Section,
  ViewLink,
  ViewSkeleton,
  counts as countParts,
  joined,
  stateWords,
} from "./hub-parts.tsx";
import { Icon } from "./icon.tsx";
import { Button } from "@/chrome/ui/button";
import { Input } from "@/chrome/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/chrome/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/chrome/ui/tabs";
import { go, useHub } from "./hub-store.ts";

/** The loaded answer, or its error; nothing while the first read is on its way. */
function Loaded<A, T>({
  result,
  children,
}: {
  result: { loaded: { args: A; data: T } | null; error: string | null };
  children: (args: A, data: T) => ReactNode;
}): ReactElement | null {
  if (result.error) return <p className="error">{result.error}</p>;
  if (!result.loaded) return <ViewSkeleton />;
  return <>{children(result.loaded.args, result.loaded.data)}</>;
}

// ── Inbox ──

function Group({
  title,
  count,
  hint,
  cls,
  children,
}: {
  title: string;
  count: number;
  hint: string;
  cls: string;
  children: ReactNode;
}) {
  const id = `h-${title.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  return (
    <section className={cls} aria-labelledby={id}>
      <div className="sec-h">
        <h2 id={id}>
          {title}
          <span className="n">{count}</span>
        </h2>
        <p className="hint">{hint}</p>
      </div>
      {children}
    </section>
  );
}

function InboxRows({ list, showProject }: { list: InboxPage[]; showProject: boolean }) {
  return (
    <ul className="rows card">
      {list.map((p) => (
        <PageRow key={p.id} p={p} showProject={showProject} notes={p.notes} />
      ))}
    </ul>
  );
}

export function InboxView(): ReactElement {
  const project = useHub((s) => s.state.project);
  const result = useLoad({ project }, (a, signal) =>
    get<InboxResponse>(`/hub/api/inbox${query({ project: a.project })}`, signal),
  );
  return (
    <Loaded result={result}>
      {(a, data) => {
        const all = data.needs_you.length + data.waiting_on_agent.length + data.quiet.length;
        if (!all)
          return (
            <>
              <header className="view-h">
                <h1>Inbox</h1>
              </header>
              <ProjectFilter project={data.project} />
              <Empty>
                {a.project
                  ? "Nothing is open for review in this project."
                  : "No pages yet. Open one for review with austere-axi and it shows up here."}
              </Empty>
            </>
          );
        const waiting = data.waiting_on_agent.length;
        const showProject = !a.project;
        return (
          <>
            <header className="view-h">
              <h1>Inbox</h1>
              <p className="summary">
                {joined([
                  data.needs_you.length ? (
                    <span className="need">
                      {plural(data.needs_you.length, "page needs", "pages need")} you
                    </span>
                  ) : (
                    "nothing needs you"
                  ),
                  waiting ? `${waiting} ${waiting === 1 ? "waits" : "wait"} on an agent` : null,
                  data.quiet.length ? `${data.quiet.length} quiet` : null,
                  data.held ? `${plural(data.held, "note")} held for release` : null,
                  data.failed_runs.length ? plural(data.failed_runs.length, "failed run") : null,
                ])}
              </p>
            </header>
            <ProjectFilter project={data.project} />
            <Group
              title="Needs you"
              count={data.needs_you.length}
              hint="The agent changed the page, a teammate's notes wait for you, or a run failed"
              cls="group needs"
            >
              {data.needs_you.length ? (
                <InboxRows list={data.needs_you} showProject={showProject} />
              ) : (
                <Empty>
                  Nothing changed since you looked, no note is held for you and no run failed.
                </Empty>
              )}
            </Group>
            <Group
              title="Waiting on agent"
              count={waiting}
              hint="Notes no agent has answered yet, and who takes them"
              cls="group waiting"
            >
              {waiting ? (
                <InboxRows list={data.waiting_on_agent} showProject={showProject} />
              ) : (
                <Empty>No unanswered notes.</Empty>
              )}
            </Group>
            <Group
              title="Quiet"
              count={data.quiet.length}
              hint="Open for review, nothing waiting"
              cls="group quiet"
            >
              {data.quiet.length ? (
                <InboxRows list={data.quiet} showProject={showProject} />
              ) : (
                <Empty>Every page has something going on.</Empty>
              )}
            </Group>
          </>
        );
      }}
    </Loaded>
  );
}

// ── Pages ──

const PAGE_VIEWS: { id: PagesView; label: string; count: "open" | "everything" | "archived" }[] = [
  { id: "open", label: "Open", count: "open" },
  { id: "all", label: "Everything", count: "everything" },
  { id: "archived", label: "Archived", count: "archived" },
];

const GROUP_LABEL: Record<string, string> = {
  needs_you: "Needs you",
  waiting_on_agent: "Waiting on agent",
  quiet: "Quiet",
};

/** The Notes column under the count: why the page wants the owner, or who takes its notes. */
function NotesLine({ p }: { p: ShellPage }) {
  if (p.changed) return <span className="why-short need">Changed since you looked</span>;
  if (p.held) return <span className="why-short need">{plural(p.held, "note")} held for you</span>;
  if (p.failed) return <span className="why-short fail">Agent run failed</span>;
  if (p.taker === "attach_on")
    return (
      <span className={`why-short${p.run_active ? " live" : ""}`}>
        {p.run_active ? "A run is working on them" : "Agent on: your next note starts a run"}
      </span>
    );
  if (p.taker === "nobody")
    return (
      <span className="why-short">
        Nobody is taking them · <a href={openLink(p.open_id, { attach: "1" })}>Turn agent on</a>
      </span>
    );
  return null;
}

/** A row of the Pages table: page · copies · notes · last activity · archive. */
function TableRow({ p, archivedView }: { p: ShellPage; archivedView: boolean }) {
  const main = p.copies.find((c) => c.id === p.open_id) ?? p.copies[0];
  const count = joined(countParts(p));
  const words = joined(stateWords(p));
  const dot = p.failed
    ? "fail"
    : p.group === "needs_you"
      ? "need"
      : p.run_active || p.taker === "listening"
        ? "live"
        : "idle";
  return (
    <li className={`row page-row trow ${p.group}`} data-page={p.id}>
      <div className="t-page">
        <span
          className={`dot ${dot}`}
          role="img"
          aria-label={p.failed ? "Agent run failed" : (GROUP_LABEL[p.group] ?? p.group)}
        />
        <div className="row-main">
          <a className="row-title" href={openLink(p.open_id)} title={main?.file ?? ""}>
            {titleOf(p)}
          </a>
          <span className="path">{p.rel_path}</span>
        </div>
      </div>
      <div className="t-copies">
        <Chips copies={p.copies} least={1} />
      </div>
      <div className="t-notes">
        {count.length ? <span className="t-count">{count}</span> : null}
        <NotesLine p={p} />
        {words.length ? <span className="meta">{words}</span> : null}
      </div>
      <span className="when">{when(p.activity)}</span>
      <div className="row-actions">
        <ArchiveButton p={p} archivedView={archivedView} />
      </div>
    </li>
  );
}

export function PagesView(): ReactElement {
  const project = useHub((s) => s.state.project);
  const pagesView = useHub((s) => s.state.pagesView);
  const projects = useHub((s) => s.projects);
  const result = useLoad({ project, pagesView }, (a, signal) =>
    get<PagesResponse>(`/hub/api/pages${query({ project: a.project, view: a.pagesView })}`, signal),
  );
  return (
    <Loaded result={result}>
      {(a, data) => {
        const { counts } = data;
        const unanswered = data.pages.reduce((n, p) => n + p.unanswered, 0);
        const projectCount = new Set(data.pages.map((p) => p.project_id)).size;
        const head = (
          <>
            <header className="view-h split">
              <div>
                <h1>Pages</h1>
                <p className="summary">
                  {joinText([
                    `${plural(data.pages.length, "page")} in ${plural(projectCount, "project")}`,
                    unanswered ? plural(unanswered, "unanswered note") : null,
                  ])}
                </p>
              </div>
              <Tabs
                value={a.pagesView}
                onValueChange={(id) => go(null, { pagesView: id as PagesView })}
              >
                <TabsList aria-label="Which pages">
                  {PAGE_VIEWS.map((v) => (
                    <TabsTrigger key={v.id} value={v.id}>
                      {v.label} <span className="n">{counts[v.count]}</span>
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </header>
            <ProjectFilter project={data.project} />
          </>
        );
        if (!data.pages.length) {
          const others = PAGE_VIEWS.filter((v) => v.id !== a.pagesView && counts[v.count] > 0).map(
            (v) => (
              <ViewLink key={v.id} next={{ pagesView: v.id }}>
                {v.label} ({counts[v.count]})
              </ViewLink>
            ),
          );
          let body: ReactNode;
          if (counts.everything === 0 && !a.project)
            body = "No pages yet. Open one for review with austere-axi and it shows up here.";
          else if (a.pagesView === "archived")
            body = (
              <>
                No archived pages.
                {others.length ? <> See: {joined(others)}.</> : null}
              </>
            );
          else
            body = (
              <>
                Nothing is open for review.
                {counts.checked ? (
                  <>
                    {" "}
                    {plural(counts.checked, "page was", "pages were")} checked but never opened:{" "}
                    <ViewLink next={{ pagesView: "all" }}>show them</ViewLink>.
                  </>
                ) : null}
                {counts.archived ? (
                  <>
                    {" "}
                    {counts.archived} archived:{" "}
                    <ViewLink next={{ pagesView: "archived" }}>show</ViewLink>.
                  </>
                ) : null}
              </>
            );
          return (
            <>
              {head}
              <Empty>{body}</Empty>
            </>
          );
        }
        const byProject = new Map<string, ShellPage[]>();
        for (const p of data.pages) {
          let list = byProject.get(p.project_id);
          if (!list) byProject.set(p.project_id, (list = []));
          list.push(p);
        }
        const info = new Map(projects.map((p) => [p.id, p]));
        const archivedView = a.pagesView === "archived";
        return (
          <>
            {head}
            <div className={`table card pages-table${archivedView ? " archived" : ""}`}>
              <div className="thead" aria-hidden="true">
                {["Page", "Copies", "Notes", "Last activity", ""].map((t, i) => (
                  <span key={i}>{t}</span>
                ))}
              </div>
              <ul className="rows">
                {[...byProject].map(([id, list]) => {
                  const pinfo = info.get(id);
                  const roots = pinfo?.roots ?? [];
                  const waiting = list.reduce((n, p) => n + p.unanswered, 0);
                  const where = roots.length
                    ? `${middle(tilde(roots[0]), 48)}${roots.length > 1 ? ` · +${roots.length - 1} more ${roots.length === 2 ? "folder" : "folders"}` : ""}`
                    : "";
                  return (
                    <ProjectRows key={id}>
                      <li className="proj-row">
                        <h2>
                          <ViewLink next={{ project: id }}>{list[0].project}</ViewLink>
                        </h2>
                        {where ? (
                          <small className="path" title={roots.join("\n")}>
                            {where}
                          </small>
                        ) : null}
                        {waiting ? (
                          <span
                            className={`proj-wait${list.some((p) => p.needs_you) ? " need" : ""}`}
                          >
                            {waiting} unanswered
                          </span>
                        ) : null}
                        {pinfo?.same_as ? (
                          <p className="same">
                            Same repository as project {pinfo.same_as.name}:{" "}
                            <code>{pinfo.same_as.merge}</code>
                          </p>
                        ) : null}
                      </li>
                      {list.map((p) => (
                        <TableRow key={p.id} p={p} archivedView={archivedView} />
                      ))}
                    </ProjectRows>
                  );
                })}
              </ul>
            </div>
            {a.pagesView === "open" && counts.checked ? (
              <p className="foot">
                {plural(counts.checked, "more page was", "more pages were")} checked but never
                opened for review. <ViewLink next={{ pagesView: "all" }}>Show them</ViewLink>
              </p>
            ) : null}
          </>
        );
      }}
    </Loaded>
  );
}

const ProjectRows = ({ children }: { children: ReactNode }) => <>{children}</>;

// ── Notes ──

/** Radix Select has no empty item value: "no filter" is this. */
const ALL = "all";

const NOTE_STATE: Record<string, string> = {
  open: "Unanswered",
  received: "Unanswered",
  addressed: "Answered",
  held: "Held for you",
};

export function NotesView(): ReactElement {
  const project = useHub((s) => s.state.project);
  const q = useHub((s) => s.state.q);
  const status = useHub((s) => s.state.status);
  const author = useHub((s) => s.state.author);
  const device = useHub((s) => s.state.device);
  const result = useLoad({ project, q, status, author, device }, (a, signal) =>
    get<NotesResponse>(`/hub/api/notes${query(a)}`, signal),
  );
  return (
    <Loaded result={result}>
      {(a, data) => {
        const waiting = data.notes.filter((n) => n.status !== "addressed").length;
        const filtered = a.q || a.project || a.author || a.device || a.status;
        return (
          <>
            <header className="view-h">
              <h1>Notes</h1>
              <p className="summary">
                {`${filtered ? "Newest first" : "Every note on every page, newest first"} · ${plural(data.notes.length, "note")}${waiting ? ` · ${waiting} unanswered` : ""}`}
              </p>
            </header>
            <form
              // The filters the URL names; typing is the form's own until it is submitted.
              key={JSON.stringify([a.q, a.status, a.author])}
              className="filters flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                const pick = (name: string): string => {
                  const x = String(f.get(name) ?? "");
                  return x === ALL ? "" : x;
                };
                go(null, {
                  q: String(f.get("q") ?? ""),
                  status: pick("status"),
                  author: pick("author"),
                });
              }}
            >
              <div className="relative min-w-0 flex-1 basis-64">
                <Icon
                  name="search"
                  size={15}
                  width={1.8}
                  cls="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  type="search"
                  name="q"
                  className="pl-8"
                  defaultValue={a.q}
                  placeholder="Search notes, targets, page titles"
                  aria-label="Search notes"
                />
              </div>
              <Select name="status" defaultValue={a.status || ALL}>
                <SelectTrigger aria-label="Status" className="min-w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All</SelectItem>
                  <SelectItem value="unanswered">Unanswered</SelectItem>
                  <SelectItem value="answered">Answered</SelectItem>
                </SelectContent>
              </Select>
              {data.authors.length ? (
                <Select name="author" defaultValue={a.author || ALL}>
                  <SelectTrigger aria-label="Author" className="min-w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>Everyone</SelectItem>
                    <SelectItem value="owner">Owner</SelectItem>
                    {data.authors.map((x) => (
                      <SelectItem key={x} value={x}>
                        {x}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
              <Button type="submit">Filter</Button>
            </form>
            <ProjectFilter project={data.project} />
            {data.device ? (
              <p className="filter">
                Device {data.device.name} ({data.device.id}) ·{" "}
                <ViewLink next={{ device: "" }}>everyone</ViewLink>
              </p>
            ) : null}
            {data.notes.length ? (
              <ul className="notes card">
                {data.notes.map((n, i) => (
                  <Note key={`${n.artifact_id}:${i}`} n={n} />
                ))}
              </ul>
            ) : (
              <Empty>{filtered ? "No notes match." : "No notes yet."}</Empty>
            )}
          </>
        );
      }}
    </Loaded>
  );
}

function Note({ n }: { n: NoteRow }) {
  const where = n.label && n.label !== n.project ? `${n.project} · ${n.label}` : n.project;
  const tone = n.status === "addressed" ? "done" : n.status === "held" ? "waiting held" : "waiting";
  const time = when(n.at);
  return (
    <li className="note">
      <span className={`st ${tone}`}>
        <span className="st-dot" aria-hidden="true" />
        {NOTE_STATE[n.status] ?? n.status}
      </span>
      <div className="note-main">
        <a href={openLink(n.artifact_id)} title={n.file}>
          <p className="quote">{n.text || "(no text)"}</p>
        </a>
        <span className="meta">
          {n.author ? <b className="by">{n.author}</b> : null}
          {n.remote ? <span>hosted page</span> : null}
          {n.target ? (
            <>
              <span>on</span>
              <code className="target">{n.target}</code>
            </>
          ) : null}
          <span>in</span>
          <a href={openLink(n.artifact_id)}>{n.title || basename(n.file)}</a>
          {where ? <span>{`· ${where}`}</span> : null}
        </span>
      </div>
      {time ? <span className="when">{time}</span> : null}
    </li>
  );
}

// ── Runs ──

const RUN_STATUS: Record<string, string> = {
  queued: "Queued",
  waiting_for_session: "Waiting for its session",
  running: "Running",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
  interrupted: "Interrupted",
};

function Run({ r }: { r: RunItem }) {
  const took =
    r.started_at && r.ended_at
      ? `${Math.max(1, Math.round((r.ended_at - r.started_at) / 1000))} s`
      : "";
  return (
    <li className={`run ${r.status}`}>
      <span className={`rstat ${r.status}`}>
        <span className="st-dot" aria-hidden="true" />
        {RUN_STATUS[r.status] ?? r.status}
      </span>
      <div className="run-main">
        {r.artifact_id ? (
          <a href={openLink(r.artifact_id)} title={r.file ?? ""}>
            {r.title || basename(r.file ?? r.artifact_id)}
          </a>
        ) : (
          <span>{r.kind === "trigger" ? "Trigger run" : "Run"}</span>
        )}
        {r.reason ? <span className="run-why">{r.reason.replace(/_/g, " ")}</span> : null}
      </div>
      <span className="agent">{joinText([r.harness, r.mode])}</span>
      <span className="when">{when(r.started_at)}</span>
      <span className="took">{took}</span>
    </li>
  );
}

export function RunsView(): ReactElement {
  const project = useHub((s) => s.state.project);
  const result = useLoad({ project }, (a, signal) =>
    get<HubRunsResponse>(`/hub/api/runs${query({ project: a.project })}`, signal),
  );
  return (
    <Loaded result={result}>
      {(_, data) => (
        <>
          <header className="view-h">
            <h1>Runs</h1>
            <p className="summary">
              Agent runs your notes started on pages where the agent is on, newest first
            </p>
          </header>
          <ProjectFilter project={data.project} />
          {data.runs.length ? (
            <div className="table card runs-table">
              <div className="thead" aria-hidden="true">
                {["Status", "Page", "Agent", "Started", "Took"].map((t) => (
                  <span key={t}>{t}</span>
                ))}
              </div>
              <ul className="runs">
                {data.runs.map((r, i) => (
                  <Run key={`${r.artifact_id}:${r.started_at}:${i}`} r={r} />
                ))}
              </ul>
            </div>
          ) : (
            <Empty>
              No runs yet. Turn an agent on in a page's Agent menu and the owner's notes start one.
            </Empty>
          )}
        </>
      )}
    </Loaded>
  );
}

// ── Search ──

function Part({ hit }: { hit: PartHit }) {
  return (
    <li className="part">
      <a href={openLink(hit.artifact_id, { part: hit.statement })} title={hit.file}>
        <span className="part-title">{`${hit.title || basename(hit.file)} · ${hit.statement}`}</span>
        <span className="snippet">{hit.snippet}</span>
      </a>
      <span className="meta">{joinText([hit.component, hit.copy])}</span>
    </li>
  );
}

export function SearchView(): ReactElement {
  const q = useHub((s) => s.state.q);
  const result = useLoad({ q }, (a, signal) =>
    get<SearchResponse>(`/hub/api/search${query({ q: a.q })}`, signal),
  );
  return (
    <Loaded result={result}>
      {(_, data) => (
        <>
          <header className="view-h">
            <h1>
              Search: <q>{data.q}</q>
            </h1>
          </header>
          <Section title="Pages" count={data.pages.length}>
            {data.pages.length ? (
              <ul className="rows card">
                {data.pages.map((p) => (
                  <PageRow key={p.id} p={p} showProject />
                ))}
              </ul>
            ) : (
              <Empty>No page title, path or project matches.</Empty>
            )}
          </Section>
          <Section title="Parts" count={data.parts.length}>
            {data.parts.length ? (
              <ul className="parts card">
                {data.parts.map((hit, i) => (
                  <Part key={`${hit.artifact_id}:${hit.statement}:${i}`} hit={hit} />
                ))}
              </ul>
            ) : (
              <Empty>No part of a page says that.</Empty>
            )}
          </Section>
        </>
      )}
    </Loaded>
  );
}
