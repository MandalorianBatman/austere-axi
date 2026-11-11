// Share by URL: the program travels in the hash, so there is no server.
//   #code=v1.<base64url of the deflate-raw bytes of the UTF-8 program>
//   #code=v0.<base64url of the UTF-8 program>      (browsers without CompressionStream)
// Any browser reads v0; reading v1 needs DecompressionStream (Chrome 80, Safari 16.4, Firefox 113).

const toBase64Url = (bytes: Uint8Array): string => {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const fromBase64Url = (text: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

async function pipe(bytes: Uint8Array<ArrayBuffer>, stream: CompressionStream | DecompressionStream): Promise<Uint8Array<ArrayBuffer>> {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

/** @returns the value of the `code` hash parameter */
export async function encodeProgram(program: string): Promise<string> {
  const bytes = new TextEncoder().encode(program);
  if (typeof CompressionStream === "function") return `v1.${toBase64Url(await pipe(bytes, new CompressionStream("deflate-raw")))}`;
  return `v0.${toBase64Url(bytes)}`;
}

/** @throws {Error} when the value is not something encodeProgram wrote */
export async function decodeProgram(value: string): Promise<string> {
  const dot = value.indexOf(".");
  const version = value.slice(0, dot);
  const body = value.slice(dot + 1);
  let bytes;
  try {
    bytes = fromBase64Url(body);
    if (version === "v1") {
      if (typeof DecompressionStream !== "function") throw new Error("This browser cannot read compressed share links (it lacks DecompressionStream).");
      bytes = await pipe(bytes, new DecompressionStream("deflate-raw"));
    } else if (version !== "v0") {
      throw new Error(`Unknown share link version "${version}".`);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (err) {
    if (/DecompressionStream|Unknown share/.test(String((err as { message?: unknown } | null | undefined)?.message))) throw err;
    throw new Error("The share link is damaged or truncated.");
  }
}

export const hashParam = (hash: string): string | null => new URLSearchParams(hash.replace(/^#/, "")).get("code");
export const hashFor = (value: string): string => `#code=${value}`;
