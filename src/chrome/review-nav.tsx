// The owner's navigation in the review header (state and routes: review-nav.ts): the breadcrumb to the hub, the switcher
// between copies of a page in several worktrees, the quick switcher (Ctrl/Cmd+K) and its button.
import { useEffect, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { ChevronDown, ChevronLeft, FileText, GitBranch, Search } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/chrome/ui/button";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@/chrome/ui/breadcrumb";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/chrome/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/chrome/ui/dropdown-menu";
import {
  GROUPS,
  closeSwitcher,
  loadPage,
  openSwitcher,
  openUrl,
  recentItems,
  restoreFocus,
  search,
  toggleSwitcher,
  useNav,
} from "./review-nav.ts";
import type { Item } from "./review-nav.ts";

const kbd = "rounded-sm border px-1.5 font-mono text-2xs leading-normal text-muted-foreground";

/** The breadcrumb `Hub / ` before the title: the project's name once the hub has answered. On a phone, a back arrow. */
export function Crumbs(): ReactElement {
  const project = useNav((s) => s.page?.project);
  const name = project?.name ?? "Hub";
  return (
    <Breadcrumb aria-label="Breadcrumb" className="flex-none">
      <BreadcrumbList className="flex-nowrap gap-2 text-[length:var(--fs)] sm:gap-2">
        <BreadcrumbItem>
          <BreadcrumbLink
            href={project ? `/?project=${encodeURIComponent(project.id)}` : "/"}
            title={project ? `${name} in the hub` : undefined}
            className="inline-flex max-w-[180px] min-w-0 items-center rounded-sm max-[860px]:max-w-[22vw] max-[480px]:size-[var(--touch)] max-[480px]:max-w-none max-[480px]:justify-center max-[480px]:rounded-md max-[480px]:text-secondary-foreground"
          >
            <ChevronLeft aria-hidden="true" className="hidden size-5 flex-none max-[480px]:block" />
            <span className="truncate max-[480px]:sr-only">{name}</span>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator className="max-[480px]:hidden">/</BreadcrumbSeparator>
      </BreadcrumbList>
    </Breadcrumb>
  );
}

/** The same page in another worktree: shown when there are two or more copies. */
export function CopySwitcher(): ReactElement | null {
  const page = useNav((s) => s.page);
  if (!page || page.copies.length < 2) return null;
  const label = (c: (typeof page.copies)[number]): string =>
    `${c.label}${c.missing ? " (missing)" : c.archived ? " (archived)" : ""}`;
  const here = page.copies.find((c) => c.id === page.id);
  const shown = here ? label(here) : page.id;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="max-w-48 flex-none font-mono text-[length:var(--fs-xs)] max-[860px]:max-w-24 max-[480px]:hidden"
          aria-label={`Worktree copy: ${shown}`}
          title="The same page in another worktree"
        >
          <GitBranch data-icon="inline-start" />
          <span className="truncate">{shown}</span>
          <ChevronDown data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup
          value={page.id}
          onValueChange={(id) => {
            if (id !== page.id) location.href = openUrl(id);
          }}
        >
          {page.copies.map((c) => (
            <DropdownMenuRadioItem key={c.id} value={c.id} className="font-mono">
              {label(c)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The header's Go to page button (the ⋯ menu has the same command). */
export function GotoButton(): ReactElement {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="icon-btn goto-btn"
      aria-label="Go to page (Ctrl K)"
      title="Go to page (Ctrl K)"
      onClick={() => openSwitcher()}
    >
      <Search />
    </Button>
  );
}

/** `text` with the words searched for marked. */
function Marked({ text, words }: { text: string; words: string[] }): ReactElement {
  const lower = text.toLowerCase();
  const out: ReactNode[] = [];
  let at = 0;
  while (words.length && at < text.length) {
    let best = -1;
    let len = 0;
    for (const w of words) {
      const i = lower.indexOf(w, at);
      if (i >= 0 && (best < 0 || i < best || (i === best && w.length > len))) {
        best = i;
        len = w.length;
      }
    }
    if (best < 0) break;
    if (best > at) out.push(text.slice(at, best));
    out.push(
      <mark key={best} className="bg-transparent text-[var(--amber)]">
        {text.slice(best, best + len)}
      </mark>,
    );
    at = best + len;
  }
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}

const DOT = {
  needs: "bg-[var(--amber)]",
  working: "bg-[var(--green)]",
  // A ring, as the hub's Inbox draws notes nobody is taking: not the agent's green.
  waiting: "bg-transparent ring-[1.5px] ring-inset ring-muted-foreground",
  quiet: "bg-[var(--faint)]",
} as const;

function Row({ item, words }: { item: Item; words: string[] }): ReactElement {
  return (
    <CommandItem
      value={`${item.kind}:${item.href}`}
      onSelect={() => (location.href = item.href)}
      className="group min-h-12 gap-3 px-2.5 py-1"
    >
      {item.kind === "part" ? (
        <span className="max-w-35 flex-none truncate rounded-sm bg-muted px-1.5 py-px font-mono text-2xs text-secondary-foreground">
          {item.chip}
        </span>
      ) : item.state ? (
        <span
          role="img"
          aria-label={item.state.label}
          title={item.state.label}
          className={cn("size-2 flex-none rounded-full", DOT[item.state.tone])}
        />
      ) : (
        <FileText aria-hidden="true" className="flex-none" />
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn("truncate text-sm", item.kind !== "part" && "font-medium")}>
          {item.kind === "part" ? <Marked text={item.title} words={words} /> : item.title}
        </span>
        <span
          className={cn(
            "truncate text-xs text-muted-foreground",
            item.kind !== "part" && "font-mono text-2xs",
          )}
        >
          {item.sub}
        </span>
      </span>
      {item.meta ? (
        <span
          className={cn(
            "max-w-[38%] flex-none truncate text-xs whitespace-nowrap sm:max-w-none",
            item.meta.changed ? "text-[var(--amber)]" : "text-muted-foreground",
          )}
        >
          {item.meta.text}
        </span>
      ) : null}
      <kbd
        aria-hidden="true"
        className={cn(kbd, "hidden max-[480px]:!hidden group-data-[selected=true]:inline-block")}
      >
        Enter
      </kbd>
    </CommandItem>
  );
}

/** Pages and parts of every project, from the hub: Ctrl/Cmd+K anywhere (the frame hands the key over), or the buttons. */
function Switcher(): ReactElement {
  const [query, setQuery] = useState("");
  const [recent] = useState(recentItems);
  /** The answer for one text: the list shows nothing older than the text in the field. */
  const [answer, setAnswer] = useState<{ q: string; items: Item[]; failed: boolean } | null>(null);
  const [tries, setTries] = useState(0);
  const q = query.trim();
  const searching = q !== "" && answer?.q !== q;
  const items = !q ? recent : answer?.q === q ? answer.items : [];
  useEffect(() => {
    if (!q) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      void search(q, ctl.signal).then((found) => {
        if (!ctl.signal.aborted) setAnswer({ q, items: found ?? [], failed: found === null });
      });
    }, 150);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [q, tries]);
  const failed = answer?.q === q && answer.failed;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return (
    <CommandDialog
      open
      onOpenChange={(open) => open || closeSwitcher()}
      title="Go to page"
      description="Search the pages and parts of every project"
      showCloseButton={false}
      onCloseAutoFocus={restoreFocus}
      className="top-[12vh] max-h-[70vh] translate-y-0 gap-0 sm:max-w-[620px] max-[480px]:top-2 max-[480px]:max-h-[calc(100dvh-16px)] max-[480px]:max-w-[calc(100%-16px)]"
    >
      {/* The server ranks the matches: cmdk's own filter would drop a part whose title lacks the words. */}
      <Command shouldFilter={false} loop className="max-h-[inherit]">
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder="Search pages and parts"
          aria-label="Search pages and parts"
        />
        <CommandList className="max-h-none flex-1 p-2">
          <CommandEmpty>
            {searching ? (
              "Searching…"
            ) : failed ? (
              <span className="flex flex-col items-center gap-2">
                Could not reach austere-axi.
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setAnswer(null);
                    setTries((n) => n + 1);
                  }}
                >
                  Try again
                </Button>
              </span>
            ) : q ? (
              "Nothing matches."
            ) : (
              "No other page opened lately. Type to search every page."
            )}
          </CommandEmpty>
          {GROUPS.map(([kind, heading]) => {
            const rows = items.filter((it) => it.kind === kind);
            return rows.length ? (
              <CommandGroup key={kind} heading={heading}>
                {rows.map((it) => (
                  <Row key={it.href} item={it} words={words} />
                ))}
              </CommandGroup>
            ) : null;
          })}
        </CommandList>
        <div className="flex flex-none flex-wrap items-center gap-x-4 gap-y-2 border-t bg-card px-4 py-2.5 text-xs text-muted-foreground max-[480px]:py-0">
          <span className="flex items-center gap-1 max-[480px]:hidden">
            <kbd className={kbd}>↑</kbd>
            <kbd className={kbd}>↓</kbd> to move
          </span>
          <span className="flex items-center gap-1 max-[480px]:hidden">
            <kbd className={kbd}>Enter</kbd> to open
          </span>
          <span className="flex items-center gap-1 max-[480px]:hidden">
            <kbd className={kbd}>Esc</kbd> to close
          </span>
          <a
            href="/"
            className="ml-auto inline-flex items-center rounded-sm text-secondary-foreground hover:text-foreground hover:underline max-[480px]:min-h-[var(--touch)]"
          >
            Open the hub
          </a>
        </div>
      </Command>
    </CommandDialog>
  );
}

/** What the owner's header does on its own: reads the page's summary, listens for Ctrl/Cmd+K, shows the switcher. */
export function OwnerNav(): ReactElement | null {
  const open = useNav((s) => s.switcher);
  useEffect(() => {
    const ctl = new AbortController();
    void loadPage(ctl.signal);
    return () => ctl.abort();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        toggleSwitcher();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  // Mounted only while open: its text and its dialog are not on the page otherwise.
  return open ? <Switcher /> : null;
}
