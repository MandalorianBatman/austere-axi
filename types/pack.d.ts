// Types for "austere-axi/pack": what a component pack imports. Hand-written
// to match src/runtime/pack-api.js and src/runtime/define.js.
import type { ZodObject, ZodRawShape, infer as ZodInfer } from "zod";

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

/** What austereComponent() returns. Put `definition.ref` in another component's props to nest it. */
export interface AustereComponent {
  name: string;
  group: string;
  notes: string[];
  slots: string[] | null;
  tagged: boolean;
  tier: "core" | "extended";
  example: string[] | null;
  stress: string[] | null;
  definition: {
    ref: any;
    [key: string]: any;
  };
}

export declare function austereComponent<Shape extends ZodRawShape>(spec: ComponentSpec<Shape>): AustereComponent;

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
