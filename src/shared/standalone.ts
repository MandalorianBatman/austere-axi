// The standalone page format, shared by `export` (CLI, from the files on disk) and the hosted
// chrome's download (browser, from the published page): the scripts a page runs are inlined
// gzipped and base64-encoded in non-executing <script type="application/x-austere-gzip"> blocks,
// and a small loader unpacks them with DecompressionStream and runs them in page order.

/** Marks the scripts a standalone page inlines (and their loader). */
export const INLINE_ATTR = "data-austere-inline";

export const PACKED_TYPE = "application/x-austere-gzip";

/**
 * Browser code, inlined into the standalone page as its source text (so it uses only its
 * argument): runs each packed script in page order; a failure replaces the page with the reason.
 */
async function unpackAndRun(type: string): Promise<void> {
  try {
    if (typeof DecompressionStream !== "function")
      throw new Error("this browser cannot unpack the page (no DecompressionStream)");
    const blocks = Array.from(
      document.querySelectorAll<HTMLScriptElement>(`script[type="${type}"]`),
    );
    const codes = await Promise.all(
      blocks.map((block) => {
        const bin = atob((block.textContent ?? "").trim());
        const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
        return new Response(
          new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")),
        ).text();
      }),
    );
    for (const code of codes) {
      const script = document.createElement("script");
      script.textContent = code;
      document.head.appendChild(script);
    }
  } catch (err) {
    document.documentElement.textContent = `This page could not start: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** The loader tag; it goes after every packed block. */
export const LOADER_TAG = `<script ${INLINE_ATTR}="loader">(${unpackAndRun})(${JSON.stringify(PACKED_TYPE)})</script>`;

/** One packed block. @param gzipB64 the script, gzipped, then base64-encoded */
export function packedTag(name: string, gzipB64: string): string {
  return `<script type="${PACKED_TYPE}" ${INLINE_ATTR}="${name.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}">${gzipB64}</script>`;
}

/** Every packed block in `html`, in page order, still gzipped and base64-encoded. */
export function packedBlocks(html: string): { name: string; gzipB64: string }[] {
  const re = new RegExp(
    `<script type="${PACKED_TYPE}" ${INLINE_ATTR}="([^"]*)">([^<]*)</script>`,
    "g",
  );
  return [...html.matchAll(re)].map((m) => ({ name: m[1], gzipB64: m[2] }));
}
