export async function readBytes(response: Response, maxBytes = 65536): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new Error('Provider response exceeded 64 KiB; keep benchmark output small.');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const buffer = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
  return buffer;
}
export async function readText(response: Response): Promise<string> {
  return new TextDecoder().decode(await readBytes(response));
}
