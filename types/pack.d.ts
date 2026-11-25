// Types for "austere-axi/pack": what a component pack imports. Hand-written
// to match src/runtime/pack-api.ts and src/runtime/define.ts.
import type { core, ZodObject, ZodRawShape, infer as ZodInfer } from "zod";
import type { ReactNode } from "react";

export type { Catalog, CatalogEntry, PackCatalog, Tier } from "./catalog.js";

/** Version of the pack API. A pack built for another major version is refused. */
export declare const PACK_API: 1;

/** Slots a content component may fill besides a Stack: "Card.children" and so on. */
export declare const CONTENT_SLOTS: readonly string[];

/** What a renderer receives. `renderNode` renders a child value from the parsed program. */
export interface RendererArgs<Props> {
  props: Props;
  renderNode: (value: unknown) => unknown;
  statementId?: string;
}

export interface ComponentSpec<Shape extends ZodRawShape = ZodRawShape> {
  /** PascalCase name the agent writes. */
  name: string;
  /** A stock group (Layout, Content, Data, Charts, Forms, Buttons) or a short capitalized category of your own. */
  group: string;
  /** zod props in positional order. Append-only once published. */
  props: ZodObject<Shape>;
  /** One line the agent reads in `spec`. */
  description: string;
  /** React component: ({ props, renderNode, statementId }) => node. */
  renderer: (args: RendererArgs<ZodInfer<ZodObject<Shape>>>) => unknown;
  /** OpenUI statements; the first calls this component. Required unless `slots` is null. */
  example?: string | string[];
  /** Like `example`, with hostile input. Never in the prompt. */
  stress?: string | string[];
  /** Extra prompt lines, each starting with "- ". */
  notes?: string[];
  /** Parent slots it may fill; null for value-only sub-components. */
  slots?: string[] | null;
  /** Wrap the output with its statement name. Default true. */
  tagged?: boolean;
  /** "extended" keeps it out of the prompt. Default "core". */
  tier?: "core" | "extended";
}

/**
 * A sub-component value as another component's renderer receives it: what
 * `z.array(Child.definition.ref)` parses to. `partial` is true while the program streams in.
 */
export interface ElementValue<Props> {
  type: "element";
  typeName: string;
  props: Props;
  partial: boolean;
}

/** The OpenUI component definition inside an AustereComponent. */
export interface ComponentDefinition<Props = unknown> {
  name: string;
  props: core.$ZodObject;
  description: string;
  /** The renderer, as passed to austereComponent(). */
  component: unknown;
  /** Use in another component's props to nest this one: `z.array(Child.definition.ref)`. */
  ref: core.$ZodType<ElementValue<Props>>;
}

/** What austereComponent() returns. Put `definition.ref` in another component's props to nest it. */
export interface AustereComponent<Props = unknown> {
  name: string;
  group: string;
  notes: string[];
  slots: string[] | null;
  tagged: boolean;
  tier: "core" | "extended";
  example: string[] | null;
  stress: string[] | null;
  definition: ComponentDefinition<Props>;
}

export declare function austereComponent<Shape extends ZodRawShape>(
  spec: ComponentSpec<Shape>,
): AustereComponent<ZodInfer<ZodObject<Shape>>>;

/** What a pack's entry module default-exports. */
export interface PackModule {
  components: AustereComponent | AustereComponent[];
  /** CSS text the runtime adds to the page once. */
  css?: string;
}

export interface PackRegistration {
  name: string;
  version: string;
  /** Defaults to PACK_API. */
  api?: number;
  components: AustereComponent | (AustereComponent | AustereComponent[])[];
  css?: string;
}

export interface RegisteredPack {
  name: string;
  version: string;
  components: AustereComponent[];
  css: string;
}

/** Called once by each pack bundle when it loads. The pack kit adds this call for you. */
export declare function registerPack(pack: PackRegistration): RegisteredPack;

/** Packs registered so far, in load order. */
export declare function registeredPacks(): RegisteredPack[];

export declare function onPackRegistered(fn: (pack: RegisteredPack) => void): () => boolean;

/** URL of a runtime asset next to austere.js, or "" when the page is inlined (export). */
export declare function assetUrl(name: string): string;

export interface RuntimeError {
  source: string;
  message: string;
  statementId?: string;
  [key: string]: unknown;
}

export declare function reportRuntimeError(err: RuntimeError): void;

/** What the content function of a DiagramFrame returns for one view of the diagram. */
export type DiagramContent =
  | {
      /** The drawing (React node), usually one <svg> that fills its width. */
      content: unknown;
      /** Natural width in px (the diagram at scale 1.0). Lets the frame shrink it to the legible scale, then scroll. Leave out to size the content yourself. */
      width?: number;
      /** Rendered under the scroll box (a legend); not scrolled. */
      caption?: unknown;
      /** Shown instead of the drawing, with no Expand button, when nothing can be drawn. */
      error?: unknown;
    }
  | {
      /** Shown instead of the drawing, with no Expand button, when nothing can be drawn. */
      error: unknown;
      content?: unknown;
      width?: number;
      caption?: unknown;
    };

export interface DiagramFrameProps {
  /**
   * Called with the room the page gives the diagram (px) and whether this is the
   * Expand dialog (`full`: draw at natural size). Return null to draw nothing.
   */
  children: (view: { room: number; full: boolean }) => DiagramContent | null;
  /** Name of the scroll region and the dialog when the diagram is not in a titled Card. Default "Diagram". */
  name?: string;
  /** Extra class on the <figure>. */
  className?: string;
  /** Ask the page for the wide column (see wantsWidePage in Architecture). */
  wide?: boolean;
  /** Smallest scale (0 to 1) the diagram shrinks to before it scrolls. Default 0.85. */
  legibleScale?: number;
}

/**
 * The frame every diagram sits in: sideways scroll with edge fades and a text cue,
 * a focusable named region, an Expand button (modal dialog, Esc returns focus),
 * and print rules. Use it as the renderer's root.
 */
export declare function DiagramFrame(props: DiagramFrameProps): ReactNode;
