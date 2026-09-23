// Adapted from t3code apps/server/src/terminal/Manager.ts (BoundedTerminalHistory,
// sanitizeTerminalHistoryChunk) (MIT, eff44be43) — see THIRD_PARTY_NOTICES.md
//
// Scrollback kept by the daemon so a viewer reload (or a second window)
// re-attaches to a running terminal and sees what it printed. A byte-bounded
// ring of string chunks: appends are O(chunk), trimming drops whole chunks
// and then cuts the first one at a line break so a replay starts on a fresh
// line rather than inside an escape sequence.

const MAX_CHUNK_LENGTH = 16 * 1024;

interface Chunk {
  data: string;
  bytes: number;
}

export class ScrollbackBuffer {
  private chunks: Chunk[] = [];
  private start = 0;
  private bytes = 0;
  private pending = "";

  constructor(readonly maxBytes: number) {}

  get byteLength(): number {
    return this.bytes;
  }

  /** Appends terminal output; terminal queries are dropped (see sanitizeReplayChunk). */
  append(data: string): void {
    const sanitized = sanitizeReplayChunk(this.pending, data);
    this.pending = sanitized.pending;
    const text = sanitized.text;
    for (let offset = 0; offset < text.length; ) {
      let end = Math.min(offset + MAX_CHUNK_LENGTH, text.length);
      const before = text.charCodeAt(end - 1);
      if (end < text.length && before >= 0xd800 && before <= 0xdbff) end -= 1; // keep surrogate pairs together
      this.push(text.slice(offset, end));
      offset = end;
    }
    this.trim();
  }

  clear(): void {
    this.chunks = [];
    this.start = 0;
    this.bytes = 0;
    this.pending = "";
  }

  value(): string {
    let out = "";
    for (let i = this.start; i < this.chunks.length; i += 1) out += this.chunks[i]?.data ?? "";
    return out;
  }

  private push(data: string): void {
    if (data.length === 0) return;
    const bytes = Buffer.byteLength(data);
    const last = this.chunks.length > this.start ? this.chunks[this.chunks.length - 1] : undefined;
    if (last !== undefined && last.data.length + data.length <= MAX_CHUNK_LENGTH) {
      last.data += data;
      last.bytes += bytes;
    } else {
      this.chunks.push({ data, bytes });
    }
    this.bytes += bytes;
  }

  private trim(): void {
    if (this.bytes <= this.maxBytes) return;
    while (this.start < this.chunks.length) {
      const first = this.chunks[this.start];
      if (first === undefined) break;
      if (this.bytes - first.bytes >= this.maxBytes) {
        this.bytes -= first.bytes;
        this.start += 1;
        continue;
      }
      // Cut inside the first chunk: drop at least the excess, then up to the next line break.
      const excess = this.bytes - this.maxBytes;
      let cut = 0;
      let dropped = 0;
      while (dropped < excess && cut < first.data.length) {
        const code = first.data.codePointAt(cut) ?? 0;
        dropped += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
        cut += code > 0xffff ? 2 : 1;
      }
      const newline = first.data.indexOf("\n", cut);
      if (newline !== -1) cut = newline + 1;
      const removed = first.data.slice(0, cut);
      first.data = first.data.slice(cut);
      const removedBytes = Buffer.byteLength(removed);
      first.bytes -= removedBytes;
      this.bytes -= removedBytes;
      if (first.data.length === 0) this.start += 1;
      break;
    }
    if (this.start > 64 && this.start * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.start);
      this.start = 0;
    }
  }
}

function isCsiFinalByte(code: number): boolean {
  return code >= 0x40 && code <= 0x7e;
}

function shouldStripCsi(body: string, finalByte: string): boolean {
  if (finalByte === "n") return true; // device status report
  if (finalByte === "R" && /^[0-9;?]*$/.test(body)) return true; // cursor position report
  if (finalByte === "c" && /^[>0-9;?]*$/.test(body)) return true; // device attributes
  if ((finalByte === "p" || finalByte === "y") && /^[0-9;?]*\$$/.test(body)) return true; // DECRQM / DECRPM
  if (finalByte === "q" && /^>[0-9;]*$/.test(body)) return true; // XTVERSION
  if (finalByte === "u" && body.startsWith("?")) return true; // kitty keyboard query
  return false;
}

function shouldStripDcs(content: string): boolean {
  return /^[01]?[$+][qr]/.test(content); // DECRQSS / XTGETTCAP queries and replies
}

function shouldStripOsc(content: string): boolean {
  return /^(10|11|12);(?:\?|rgb:)/.test(content); // colour queries
}

function stringTerminatorEnd(input: string, start: number): number | null {
  for (let i = start; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code === 0x07 || code === 0x9c) return i + 1;
    if (code === 0x1b && input.charCodeAt(i + 1) === 0x5c) return i + 2;
  }
  return null;
}

function stripTerminator(value: string): string {
  if (value.endsWith("\u001b\\")) return value.slice(0, -2);
  const last = value.at(-1);
  return last === "\u0007" || last === "\u009c" ? value.slice(0, -1) : value;
}

/**
 * Drops request/response traffic (cursor-position and device-attribute
 * queries, colour queries, …) from output kept for replay: replaying a stored
 * query makes the new viewer answer it again, and the shell would echo the
 * answer as junk at the prompt. An escape sequence split across chunks is held
 * back in `pending` until it is complete.
 */
export function sanitizeReplayChunk(pending: string, data: string): { text: string; pending: string } {
  const input = pending + data;
  let text = "";
  let i = 0;
  while (i < input.length) {
    const code = input.charCodeAt(i);
    if (code === 0x1b) {
      const next = input.charCodeAt(i + 1);
      if (Number.isNaN(next)) return { text, pending: input.slice(i) };
      if (next === 0x5b) {
        let cursor = i + 2;
        while (cursor < input.length && !isCsiFinalByte(input.charCodeAt(cursor))) cursor += 1;
        if (cursor >= input.length) return { text, pending: input.slice(i) };
        if (!shouldStripCsi(input.slice(i + 2, cursor), input[cursor] ?? "")) text += input.slice(i, cursor + 1);
        i = cursor + 1;
        continue;
      }
      if (next === 0x5d || next === 0x50 || next === 0x5e || next === 0x5f) {
        const end = stringTerminatorEnd(input, i + 2);
        if (end === null) {
          // An unterminated string sequence longer than 64 KiB is not a sequence: keep it as text.
          if (input.length - i > 65_536) {
            text += input.slice(i);
            return { text, pending: "" };
          }
          return { text, pending: input.slice(i) };
        }
        const content = stripTerminator(input.slice(i + 2, end));
        const strip = (next === 0x5d && shouldStripOsc(content)) || (next === 0x50 && shouldStripDcs(content));
        if (!strip) text += input.slice(i, end);
        i = end;
        continue;
      }
      // Other escape: intermediates (0x20–0x2f) then one final byte.
      let cursor = i + 1;
      while (cursor < input.length && input.charCodeAt(cursor) >= 0x20 && input.charCodeAt(cursor) <= 0x2f) cursor += 1;
      if (cursor >= input.length) return { text, pending: input.slice(i) };
      const finalCode = input.charCodeAt(cursor);
      const end = finalCode >= 0x30 && finalCode <= 0x7e ? cursor + 1 : i + 1;
      text += input.slice(i, end);
      i = end;
      continue;
    }
    // Fast path: copy the run up to the next ESC.
    const nextEsc = input.indexOf("\u001b", i);
    const end = nextEsc === -1 ? input.length : nextEsc;
    text += input.slice(i, end);
    i = end;
  }
  return { text, pending: "" };
}

/** Tracks the alternate screen (vim, top, less …) so a re-attach can make the app redraw. */
export function altScreenAfter(current: boolean, data: string): boolean {
  if (!data.includes("\u001b[?")) return current;
  const re = /\u001b\[\?(?:1049|1047|47)([hl])/g;
  let state = current;
  for (let m = re.exec(data); m !== null; m = re.exec(data)) state = m[1] === "h";
  return state;
}
