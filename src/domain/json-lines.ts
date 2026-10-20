// Decode streaming responses without assuming that a network chunk ends at a
// JSON or UTF-8 boundary. The limit applies to one event, not the whole stream.
export async function* readJsonLines(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        if (line.length > 8_000_000) throw new Error("Metrics event is too large.");
        buffer = buffer.slice(newline + 1);
        if (line) yield JSON.parse(line) as unknown;
      }
      if (buffer.length > 8_000_000) throw new Error("Metrics event is too large.");
      if (chunk.done) {
        if (buffer.trim()) yield JSON.parse(buffer) as unknown;
        completed = true;
        return;
      }
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
