// The hub shell on austere-cloud (`HubBoot.mode` "cloud"): the views the Worker can fill from D1 (Pages, Shared,
// search over titles), the People dialog (grant and revoke by email) and the account footer. The frame, sidebar,
// type and colours are the local hub's; only what a machine holds (inbox, notes, runs, settings, copies) is missing.
import { Fragment, useEffect, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { create } from "zustand";
import type {
  GrantResult,
  GrantsResponse,
  PagesResponse,
  SearchResponse,
  SharedResponse,
  ShellPage,
} from "../shared/hub-api.ts";
import { joinText, plural } from "./format.ts";
import { BOOT } from "./hub-env.ts";
import { get, query, send } from "./hub-http.ts";
import { useLoad } from "./hub-load.ts";
import { Empty, ProjectFilter, ViewLink } from "./hub-parts.tsx";
import { Loaded } from "./hub-views.tsx";
import { reload, useHub } from "./hub-store.ts";
import { Button } from "@/chrome/ui/button";
import { XIcon } from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/chrome/ui/dialog";
import { Input } from "@/chrome/ui/input";
import { Label } from "@/chrome/ui/label";

export const INSTALL_GUIDE =
  "https://github.com/MandalorianBatman/austere-axi/blob/main/docs/install.md";

const DAY = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "23 Dec 2026", in UTC. */
export function dateOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** When a page expires, in words: from 3 days out it says "in 2 days" or "today", and `soon` is set (never colour alone). */
export function expiryText(ms: number, now = Date.now()): { text: string; soon: boolean } {
  const left = ms - now;
  if (left < DAY) return { text: "Expires today", soon: true };
  const days = Math.ceil(left / DAY);
  if (days <= 3) return { text: `Expires in ${days} days`, soon: true };
  return { text: `Expires ${dateOf(ms)} · in ${days} days`, soon: false };
}

function Expiry({ ms }: { ms: number }): ReactElement {
  const { text, soon } = expiryText(ms);
  return (
    <time className={soon ? "soon" : undefined} dateTime={new Date(ms).toISOString()}>
      {text}
    </time>
  );
}

/** Where a page opens on the cloud. */
export const pageHref = (p: { open_id: string }): string => `/p/${p.open_id}`;

const title = (p: { title: string | null }): string => p.title?.trim() || "Untitled page";

// ── People dialog ──

const useWho = create<{ page: { id: string; title: string } | null; opener: Element | null }>(
  () => ({ page: null, opener: null }),
);

/** Open the People dialog for a page; focus goes back to `opener` (the button) when it closes. */
export function openPeople(page: { id: string; title: string }): void {
  useWho.setState({ page, opener: document.activeElement });
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

const SAID = {
  granted: "Access granted. They open the page after they sign in with that email.",
  exists: "That email already has access.",
  revoked: "Access revoked. Any tab they have open on this page loses access now.",
  email: "Enter an email address, like name@example.com.",
} as const;

type Line = { role: "status" | "alert"; text: string } | null;

function People({ page, opener }: { page: { id: string; title: string }; opener: Element | null }) {
  const [data, setData] = useState<GrantsResponse | null>(null);
  const [line, setLine] = useState<Line>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const route = `/hub/api/pages/${page.id}/grants`;
  const close = (): void => useWho.setState({ page: null, opener: null });

  useEffect(() => {
    const ctl = new AbortController();
    get<GrantsResponse>(route, ctl.signal).then(setData, (err: unknown) => {
      if (!ctl.signal.aborted)
        setLine({ role: "alert", text: err instanceof Error ? err.message : "Could not load." });
    });
    return () => ctl.abort();
  }, [route]);

  async function change(path: string, who: string): Promise<GrantResult | null> {
    setBusy(true);
    const r = await send<GrantResult>(`${route}${path}`, { email: who });
    setBusy(false);
    if (!r.ok) {
      setLine({
        role: "alert",
        text:
          data && data.grants.length >= data.limit && path === ""
            ? `This page has ${data.limit} grants, the most it can have. Revoke one first.`
            : r.error,
      });
      return null;
    }
    setData(r.data);
    setLine({ role: "status", text: SAID[r.data.status] });
    // The table's People count reads again.
    reload();
    return r.data;
  }

  const invalid = line?.role === "alert" && line.text === SAID.email;
  return (
    <Dialog open onOpenChange={(open) => open || close()}>
      <DialogContent
        showCloseButton={false}
        className="max-h-[90vh] overflow-y-auto"
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
          else document.getElementById("content")?.focus();
        }}
      >
        <DialogClose className="people-close absolute top-2 right-2 inline-flex size-11 items-center justify-center rounded-md opacity-70 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden sm:top-3 sm:right-3 sm:size-9">
          <XIcon className="size-4" />
          <span className="sr-only">Close</span>
        </DialogClose>
        <DialogHeader>
          <DialogTitle>People</DialogTitle>
          <DialogDescription className="break-words">
            Who can open {page.title || "Untitled page"}.
          </DialogDescription>
        </DialogHeader>
        {data ? (
          <table className="people w-full text-sm">
            <caption className="sr-only">Who can open {page.title || "Untitled page"}</caption>
            <thead className="max-xs:hidden text-left text-xs tracking-wider text-muted-foreground uppercase">
              <tr>
                <th scope="col" className="py-1 font-semibold">
                  Account
                </th>
                <th scope="col" className="py-1 font-semibold">
                  Access
                </th>
                <th scope="col" className="py-1">
                  <span className="sr-only">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-[var(--line)] max-xs:grid max-xs:grid-cols-[1fr_auto] max-xs:items-center max-xs:gap-x-2">
                <th
                  scope="row"
                  className="py-2 pr-2 text-left font-normal [overflow-wrap:anywhere] max-xs:col-span-2 max-xs:pb-0"
                >
                  {data.owner}
                </th>
                <td className="py-2 pr-2 whitespace-nowrap">Owner</td>
                <td />
              </tr>
              {data.grants.length ? (
                data.grants.map((g) => (
                  <tr
                    key={g.email}
                    className="border-t border-[var(--line)] max-xs:grid max-xs:grid-cols-[1fr_auto] max-xs:items-center max-xs:gap-x-2"
                  >
                    <th
                      scope="row"
                      className="py-2 pr-2 text-left font-normal [overflow-wrap:anywhere] max-xs:col-span-2 max-xs:pb-0"
                    >
                      {g.email}
                    </th>
                    <td className="py-2 pr-2 whitespace-nowrap max-xs:text-muted-foreground">
                      Added {dateOf(g.added_at)}
                    </td>
                    <td className="py-1 text-right">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        className="max-xs:h-11"
                        aria-label={`Revoke access for ${g.email}`}
                        onClick={() => void change("/remove", g.email)}
                      >
                        Revoke
                      </Button>
                    </td>
                  </tr>
                ))
              ) : (
                <tr className="border-t border-[var(--line)]">
                  <td colSpan={3} className="py-2 text-muted-foreground">
                    No accounts granted.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        ) : line ? null : (
          <p className="text-sm text-muted-foreground" role="status">
            Loading…
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Invite links you make with the CLI are not listed here.
        </p>
        <form
          className="grid gap-2"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const who = email.trim().toLowerCase();
            if (!EMAIL.test(who)) {
              setLine({ role: "alert", text: SAID.email });
              return;
            }
            void change("", who).then((done) => done && setEmail(""));
          }}
        >
          <Label htmlFor="grant-email">Grant access by email</Label>
          <div className="flex gap-2 max-xs:flex-col">
            <Input
              id="grant-email"
              type="email"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={email}
              aria-invalid={invalid ? true : undefined}
              aria-describedby="grant-help"
              onChange={(e) => setEmail(e.target.value)}
              className="min-w-0 flex-1 max-xs:h-11 max-xs:flex-none"
            />
            <Button type="submit" disabled={busy || !data} className="max-xs:h-11">
              Grant
            </Button>
          </div>
          <p id="grant-help" className="text-xs text-muted-foreground">
            They sign in with this email (email code, Google, GitHub or a passkey) to open the page.
          </p>
        </form>
        {line ? (
          <p
            role={line.role}
            className={`text-sm font-medium ${line.role === "alert" ? "text-destructive" : ""}`}
          >
            {line.text}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** Mounted once: draws the People dialog of the page asked for. */
export function PeopleDialog(): ReactElement | null {
  const { page, opener } = useWho();
  // `key`: another page starts a fresh read.
  return page ? <People key={page.id} page={page} opener={opener} /> : null;
}

// ── Pages ──

/** The sidebar footer: who is signed in, and Sign out (a form POST: the Worker ends the session and answers a redirect). */
export function AccountFooter(): ReactElement | null {
  const account = BOOT.account;
  if (!account) return null;
  return (
    <div className="account flex flex-col gap-2">
      <div className="min-w-0 text-sm">
        <span className="block truncate font-medium text-foreground">
          {account.name || account.email}
        </span>
        {account.name ? (
          <span className="block truncate text-xs text-muted-foreground">{account.email}</span>
        ) : null}
      </div>
      <form method="post" action="/auth/logout">
        <Button type="submit" variant="outline" size="sm" className="account-out w-full">
          Sign out
        </Button>
      </form>
    </div>
  );
}

function Cmd({ children }: { children: string }): ReactElement {
  return (
    <div className="cmd">
      <span aria-hidden="true">$</span> <code>{children}</code>
    </div>
  );
}

/** No page at all: how to publish the first one. */
function NoPages(): ReactElement {
  return (
    <div className="empty cloud-empty">
      <h2>No pages yet.</h2>
      <p>
        Pages you publish while the CLI is signed in as {BOOT.account?.email ?? "you"} show up here.
      </p>
      <Cmd>austere-axi cloud login</Cmd>
      <Cmd>austere-axi publish &lt;file&gt;</Cmd>
      <p>
        <a href={INSTALL_GUIDE}>New to austere-axi? Install guide</a>
      </p>
    </div>
  );
}

function PageRows({ pages }: { pages: ShellPage[] }): ReactElement {
  const byProject = new Map<string, ShellPage[]>();
  for (const p of pages) {
    let list = byProject.get(p.project_id);
    if (!list) byProject.set(p.project_id, (list = []));
    list.push(p);
  }
  return (
    <div className="table card pages-table cloud-table" role="table" aria-label="Pages">
      <div className="thead" role="row">
        {["Page", "People", "Notes", "Expires"].map((t) => (
          <span key={t} role="columnheader">
            {t}
          </span>
        ))}
      </div>
      <ul className="rows" role="rowgroup">
        {[...byProject].map(([id, list]) => (
          <Fragment key={id}>
            <li className="proj-row" role="row">
              <div className="contents" role="cell">
                <h2>
                  <ViewLink next={{ project: id }}>{list[0].project}</ViewLink>
                </h2>
              </div>
            </li>
            {list.map((p) => (
              <PageRow key={p.id} p={p} />
            ))}
          </Fragment>
        ))}
      </ul>
    </div>
  );
}

function PageRow({ p }: { p: ShellPage }): ReactElement {
  const facts = p.cloud;
  return (
    <li className="row page-row trow" data-page={p.id} role="row">
      <div className="t-page" role="cell">
        <div className="row-main flex min-w-0 flex-[1_1_15rem] flex-col gap-1">
          <a className="row-title" href={pageHref(p)} title={p.rel_path}>
            {title(p)}
          </a>
          <span className="path">{`${location.host}/p/${p.id}`}</span>
        </div>
      </div>
      <div className="t-people" role="cell">
        {facts ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={`People who can open ${title(p)}: ${facts.people}`}
            onClick={() => openPeople({ id: p.id, title: p.title?.trim() ?? "" })}
          >
            People <span className="n">{facts.people}</span>
          </Button>
        ) : null}
      </div>
      <div className="t-notes" role="cell">
        {facts ? (
          <span className="t-count">
            {facts.notes === 0 ? "No notes yet" : plural(facts.notes, "note")}
          </span>
        ) : null}
      </div>
      <span className="when" role="cell">
        {facts ? <Expiry ms={facts.expires_at} /> : null}
      </span>
    </li>
  );
}

export function CloudPagesView(): ReactElement {
  const project = useHub((s) => s.state.project);
  const result = useLoad({ project }, (a, signal) =>
    get<PagesResponse>(`/hub/api/pages${query({ project: a.project })}`, signal),
  );
  return (
    <Loaded result={result} title="Pages">
      {(a, data) => {
        const groups = new Set(data.pages.map((p) => p.project_id)).size;
        const notes = data.pages.reduce((n, p) => n + (p.cloud?.notes ?? 0), 0);
        return (
          <>
            <header className="view-h">
              <h1>Pages</h1>
              {data.pages.length ? (
                <p className="summary">
                  {joinText([
                    `${plural(data.pages.length, "page")} in ${plural(groups, "project")}`,
                    notes ? plural(notes, "note") : null,
                  ])}
                </p>
              ) : null}
            </header>
            <ProjectFilter asked={a.project} project={data.project} />
            {data.pages.length ? (
              <PageRows pages={data.pages} />
            ) : a.project ? (
              <Empty>
                No pages in this project. <ViewLink next={{ project: "" }}>All projects</ViewLink>
              </Empty>
            ) : (
              <NoPages />
            )}
          </>
        );
      }}
    </Loaded>
  );
}

// ── Shared with you ──

export function SharedView(): ReactElement {
  const result = useLoad({}, (_, signal) => get<SharedResponse>("/hub/api/shared", signal));
  return (
    <Loaded result={result} title="Shared with you">
      {(_, data) => (
        <>
          <header className="view-h">
            <h1>Shared with you</h1>
            <p className="summary">{plural(data.pages.length, "page")}</p>
          </header>
          {data.pages.length ? (
            <div
              className="table card pages-table shared-table"
              role="table"
              aria-label="Shared with you"
            >
              <div className="thead" role="row">
                {["Page", "Owner", "Expires"].map((t) => (
                  <span key={t} role="columnheader">
                    {t}
                  </span>
                ))}
              </div>
              <ul className="rows" role="rowgroup">
                {data.pages.map((p) => (
                  <li key={p.id} className="row page-row trow" data-page={p.id} role="row">
                    <div className="t-page" role="cell">
                      <a className="row-title" href={pageHref({ open_id: p.id })}>
                        {title(p)}
                      </a>
                    </div>
                    <div className="t-people" role="cell">
                      {p.owner}
                    </div>
                    <span className="when" role="cell">
                      <Expiry ms={p.expires_at} />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <Empty>
              Nothing shared with you yet. When an owner grants {BOOT.account?.email ?? "you"}, the
              page shows up here.
            </Empty>
          )}
        </>
      )}
    </Loaded>
  );
}

// ── Search ──

/** Search on the cloud reads page titles (and their project and path) only: the content is in each page's own object. */
export function CloudSearchView(): ReactElement {
  const q = useHub((s) => s.state.q);
  const result = useLoad({ q }, (a, signal) =>
    get<SearchResponse>(`/hub/api/search${query({ q: a.q })}`, signal),
  );
  const { loaded } = result;
  const status: ReactNode = loaded ? plural(loaded.data.pages.length, "page") + " match" : "";
  return (
    <>
      <p role="status" className="sr-only">
        {status}
      </p>
      <Loaded result={result} title="Search">
        {(_, data) => (
          <>
            <header className="view-h">
              <h1>
                Search: <q>{data.q}</q>
              </h1>
            </header>
            {data.pages.length ? (
              <PageRows pages={data.pages} />
            ) : (
              <Empty>No page title, path or project matches.</Empty>
            )}
          </>
        )}
      </Loaded>
    </>
  );
}
