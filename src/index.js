const encoder = new TextEncoder();

// Builds the SMTP DATA payload: bare LF -> CRLF, dot-stuffing, trailing CRLF and the "." terminator.
// Works on raw bytes so 8-bit content passes through untouched; unchanged runs are copied in bulk.
export function encodeData(bytes) {
  const len = bytes.length;
  let lines = 1;
  for (let i = bytes.indexOf(10); i !== -1; i = bytes.indexOf(10, i + 1)) lines++;
  // Each line grows by at most a stuffed dot plus a CR; the last line may need CRLF; then ".\r\n".
  const out = new Uint8Array(len + 2 * lines + 4);
  let o = 0;
  let done = 0; // bytes[0..done) are already in out
  const copyTo = (end) => {
    out.set(bytes.subarray(done, end), o);
    o += end - done;
    done = end;
  };
  for (let pos = 0; pos < len; ) {
    if (bytes[pos] === 46) { copyTo(pos); out[o++] = 46; }
    const nl = bytes.indexOf(10, pos);
    if (nl === -1) break;
    if (bytes[nl - 1] !== 13) { copyTo(nl); out[o++] = 13; }
    pos = nl + 1;
  }
  copyTo(len);
  if (len > 0 && bytes[len - 1] !== 10) { out[o++] = 13; out[o++] = 10; }
  out[o++] = 46; out[o++] = 13; out[o++] = 10;
  return out.subarray(0, o);
}

// Minimal SMTP client over a Workers-style socket ({ readable, writable, close }).
export async function relay(socket, { from, to, raw }) {
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  const decoder = new TextDecoder();
  let buf = '';
  const send = (data) => writer.write(typeof data === 'string' ? encoder.encode(data) : data);
  const expect = async (code) => {
    let m;
    // A reply is any number of "NNN-" continuation lines followed by a final "NNN" or "NNN text" line.
    while (!(m = /^(?:\d{3}-.*\r?\n)*(\d{3})(?: .*)?\r?\n/.exec(buf))) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`SMTP connection closed while expecting ${code}: ${buf.trim()}`);
      buf += decoder.decode(value, { stream: true });
    }
    buf = buf.slice(m[0].length);
    if (m[1] !== String(code)) throw new Error(`SMTP expected ${code}, got: ${m[0].trim()}`);
  };
  try {
    await expect(220);
    await send('EHLO junkmail\r\n');
    await expect(250);
    await send(`MAIL FROM:<${from || ''}>\r\n`);
    await expect(250);
    await send(`RCPT TO:<${to}>\r\n`);
    await expect(250);
    await send('DATA\r\n');
    await expect(354);
    // ponytail: buffers the whole message (Cloudflare caps it at 25 MiB, ~2x that in memory with the
    // encoded copy); switch to a streaming TransformStream encoder if the memory ceiling becomes a problem.
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(await new Response(raw).arrayBuffer());
    await send(encodeData(bytes));
    await expect(250);
    await send('QUIT\r\n');
  } finally {
    await socket.close();
  }
}

export default {
  async email(message, env) {
    const socket = await env.HOME.connect(env.MAILPIT_ADDR);
    await relay(socket, { from: message.from, to: message.to, raw: message.raw });
  },
};
