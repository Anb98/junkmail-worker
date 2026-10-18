import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { Duplex } from 'node:stream';
import { encodeData, relay } from '../src/index.js';

const MAILPIT_API = 'http://127.0.0.1:8025/api/v1';
const bytes = (s) => new Uint8Array(Buffer.from(s, 'latin1'));
const text = (u8) => Buffer.from(u8).toString('latin1');

// Adapts a Node socket to the Workers socket shape returned by connect().
function workersSocket(socket) {
  const { readable, writable } = Duplex.toWeb(socket);
  return { readable, writable, close: () => socket.destroy() };
}

function connect(port, host) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host, () => resolve(workersSocket(socket)));
    socket.once('error', reject);
  });
}

test('encodeData dot-stuffs every line starting with a dot, including the first', () => {
  assert.equal(text(encodeData(bytes('.first\r\nmid\r\n..two\r\n'))), '..first\r\nmid\r\n...two\r\n.\r\n');
});

test('encodeData converts bare LF to CRLF without doubling existing CRLF', () => {
  assert.equal(text(encodeData(bytes('a\nb\r\nc\n\nd\r\n'))), 'a\r\nb\r\nc\r\n\r\nd\r\n.\r\n');
});

test('encodeData terminates a body that lacks a trailing newline', () => {
  assert.equal(text(encodeData(bytes('no newline'))), 'no newline\r\n.\r\n');
  assert.equal(text(encodeData(bytes('.'))), '..\r\n.\r\n');
});

test('encodeData preserves bytes 0x80-0xFF byte-for-byte', () => {
  const high = Uint8Array.from({ length: 128 }, (_, i) => 0x80 + i);
  const out = encodeData(high);
  assert.deepEqual(out.subarray(0, 128), high);
  assert.equal(text(out.subarray(128)), '\r\n.\r\n');
});

test('encodeData output always ends with the DATA terminator', () => {
  for (const input of ['', 'x', 'x\n', 'x\r\n', '.\n.']) {
    assert.ok(text(encodeData(bytes(input))).endsWith('.\r\n'), JSON.stringify(input));
  }
  assert.ok(text(encodeData(bytes('body\n'))).endsWith('\r\n.\r\n'));
});

test('relay rejects with the server reply when RCPT is refused', async (t) => {
  const server = net.createServer((conn) => {
    conn.write('220 fake ESMTP\r\n');
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (line.startsWith('EHLO')) conn.write('250-fake\r\n250 8BITMIME\r\n');
        else if (line.startsWith('MAIL')) conn.write('250 OK\r\n');
        else if (line.startsWith('RCPT')) conn.write('550 5.1.1 No such user\r\n');
        else conn.write('500 Unexpected\r\n');
      }
    });
    conn.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const socket = await connect(server.address().port, '127.0.0.1');
  await assert.rejects(
    relay(socket, { from: 'a@example.com', to: 'nobody@example.com', raw: bytes('Subject: x\r\n\r\nhi\r\n') }),
    /550/,
  );
});

test('relay delivers to the local Mailpit with dot lines and 8-bit bytes intact', async (t) => {
  try {
    await fetch(`${MAILPIT_API}/info`, { signal: AbortSignal.timeout(1000) });
  } catch {
    t.skip('Mailpit API is not reachable on 127.0.0.1:8025');
    return;
  }

  const tag = `relay-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const envelopeTo = `${tag}@junk.test`;
  const body = '.single dot line\n..double dot line\nplain line with caf\xe9\n.\n';
  const message = `From: sender@example.com\nTo: header@junk.test\nSubject: ${tag}\n\n${body}`;
  const socket = await connect(1025, '127.0.0.1');
  await relay(socket, {
    from: 'sender@example.com',
    to: envelopeTo,
    raw: new Blob([bytes(message)]).stream(),
  });

  let found;
  for (let i = 0; i < 30 && !found; i++) {
    const res = await fetch(`${MAILPIT_API}/search?query=${encodeURIComponent(`subject:"${tag}"`)}`);
    found = (await res.json()).messages?.[0];
    if (!found) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(found, 'message not found in Mailpit');
  t.after(() =>
    fetch(`${MAILPIT_API}/messages`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ IDs: [found.ID] }),
    }),
  );

  const raw = Buffer.from(await (await fetch(`${MAILPIT_API}/message/${found.ID}/raw`)).arrayBuffer());
  assert.ok(raw.includes(Buffer.from(body.replaceAll('\n', '\r\n'), 'latin1')), raw.toString('latin1'));
  const recipients = [...(found.To ?? []), ...(found.Cc ?? []), ...(found.Bcc ?? [])].map((a) => a.Address);
  assert.ok(recipients.includes(envelopeTo), JSON.stringify(recipients));
});
