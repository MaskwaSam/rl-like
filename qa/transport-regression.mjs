/** Run with `node qa/transport-regression.mjs`; exercises production Link with fake channels. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = await mkdtemp(join(tmpdir(), 'car-transport-test-'));
const originalNow = Object.getOwnPropertyDescriptor(performance, 'now');
let now = 0;
Object.defineProperty(performance, 'now', { configurable: true, value: () => now });
try {
  await build({
    root, configFile: false, logLevel: 'error',
    plugins: [{
      name: 'transport-test-peer', enforce: 'pre',
      resolveId(id) { if (id === 'peerjs') return '\0test-peer'; },
      load(id) { if (id === '\0test-peer') return 'export class Peer {}'; },
    }],
    build: {
      ssr: join(root, 'src/net/transport.ts'), outDir, emptyOutDir: true,
      target: 'esnext', minify: false,
      rollupOptions: { output: { entryFileNames: 'transport.mjs' } },
    },
    ssr: { noExternal: ['peerjs'] },
  });
  const { Link } = await import(pathToFileURL(join(outDir, 'transport.mjs')));
  const packet = new ArrayBuffer(32);
  function channel() {
    return {
      label: 'fast', readyState: 'open', bufferedAmount: 0, sent: [],
      send(data) { this.sent.push(data); this.bufferedAmount += data.byteLength; },
      close() { this.readyState = 'closed'; this.onclose?.(); },
    };
  }
  function connection() {
    return {
      open: true, bufferSize: 0, dataChannel: channel(), sent: [], events: {},
      peerConnection: { createDataChannel() { return channel(); } },
      on(name, fn) { this.events[name] = fn; },
      send(data) { this.sent.push(data); this.dataChannel.bufferedAmount += typeof data === 'string' ? data.length : data.byteLength; },
      close() { this.open = false; this.events.close?.(); },
    };
  }
  function fastLink() {
    const conn = connection(), link = new Link(conn, true), fast = channel();
    link.start(); // Exercise the real host handshake/listener without private member access.
    assert.equal(JSON.parse(conn.sent[0]).t, 'fastready');
    conn.sent.length = 0; conn.dataChannel.bufferedAmount = 0;
    conn.peerConnection.ondatachannel({ channel: fast });
    return { conn, link, fast };
  }

  {
    const { conn, link, fast } = fastLink();
    assert.equal(link.fastOpen, true);
    link.sendFast(packet);
    for (let i = 0; i < 1000; i++) link.sendFast(packet);
    assert.equal(fast.sent.length, 1, 'stalled fast channel admits one packet');
    assert.equal(conn.sent.length, 0, 'fast congestion never spills onto reliable');
    assert.equal(link.trafficDiagnostics.droppedBackpressure, 1000);
    assert.equal(link.trafficDiagnostics.fastBufferedBytes, 32);
    fast.bufferedAmount = 0; link.sendFast(packet);
    assert.equal(link.trafficDiagnostics.fastSubmitted, 2, 'resume after drain');
    fast.bufferedAmount = 1; link.sendFast(packet);
    assert.equal(fast.sent.length, 2, 'even one queued byte blocks stale traffic');
    const snapshot = link.trafficDiagnostics; snapshot.fastSubmitted = 99;
    assert.equal(link.trafficDiagnostics.fastSubmitted, 2, 'diagnostics are snapshots');
    link.close(); link.sendFast(packet);
    assert.equal(link.fastOpen, false);
    assert.equal(link.trafficDiagnostics.droppedUnavailable, 1);
  }
  {
    const conn = connection(), link = new Link(conn, false);
    link.sendFast(packet);
    for (let i = 0; i < 1000; i++) link.sendFast(packet);
    assert.equal(conn.sent.length, 1, 'stalled reliable fallback admits one packet');
    assert.equal(link.trafficDiagnostics.fallbackSubmitted, 1);
    conn.dataChannel.bufferedAmount = 0; conn.bufferSize = 1;
    link.sendFast(packet);
    assert.equal(conn.sent.length, 1, 'PeerJS queue also blocks gameplay');
    assert.equal(link.trafficDiagnostics.reliableQueuedMessages, 1);
    link.sendCtrl({ t: 'fastready' });
    assert.equal(conn.sent.length, 2, 'controls still enter reliable path under congestion');
    conn.bufferSize = 0; conn.dataChannel.bufferedAmount = 0;
    link.sendFast(packet);
    assert.equal(link.trafficDiagnostics.fallbackSubmitted, 2, 'fallback resumes after both queues drain');
    conn.open = false; link.sendFast(packet);
    assert.equal(link.trafficDiagnostics.droppedUnavailable, 1);
  }
  {
    const { conn, link, fast } = fastLink();
    fast.send = () => { throw new Error('closed during send'); };
    link.sendFast(packet);
    assert.equal(link.trafficDiagnostics.sendErrors, 1);
    assert.equal(link.trafficDiagnostics.fallbackSubmitted, 1, 'send race can use empty reliable fallback');
    link.sendFast(packet);
    assert.equal(conn.sent.length, 1, 'send race still respects fallback backlog');
    assert.equal(link.trafficDiagnostics.droppedBackpressure, 1);
  }
  {
    const { conn, link, fast } = fastLink();
    fast.close(); link.sendFast(packet);
    assert.equal(link.fastOpen, false);
    assert.equal(conn.sent.length, 1, 'closed fast channel preserves reliable fallback');
    conn.dataChannel.bufferedAmount = 0;
    conn.send = () => { throw new Error('reliable send failed'); };
    link.sendFast(packet);
    assert.equal(link.trafficDiagnostics.sendErrors, 1);
  }
  {
    const conn = connection(), link = new Link(conn, false);
    link.start();
    conn.events.data(JSON.stringify({ t: 'fastready' }));
    assert.equal(link.fastOpen, true, 'client still creates fast channel on invitation');
    let received;
    link.onFast = data => { received = data; };
    conn.events.data(packet);
    assert.equal(received, packet, 'reliable gameplay receive path remains supported');
  }
  {
    now = 0;
    const { conn, link, fast } = fastLink();
    link.sendFast(packet);
    now = 249; link.sendFast(new ArrayBuffer(33));
    assert.equal(link.fastOpen, true, 'short stall keeps fast channel');
    assert.equal(conn.sent.length, 0, 'short stall does not spill onto reliable');
    const fresh = new ArrayBuffer(34);
    now = 251; link.sendFast(fresh);
    assert.equal(fast.readyState, 'closed', 'stuck channel retires after threshold');
    assert.equal(conn.open, true, 'retirement preserves reliable connection');
    assert.deepEqual(fast.sent, [packet], 'obsolete traffic is never resubmitted');
    assert.deepEqual(conn.sent, [fresh], 'only current fresh packet uses fallback');
    assert.equal(link.trafficDiagnostics.fastStallRecoveries, 1);
    for (let i = 0; i < 1000; i++) link.sendFast(packet);
    assert.equal(conn.sent.length, 1, 'recovered fallback queue stays bounded');
    link.sendCtrl({ t: 'fastready' });
    assert.equal(conn.sent.length, 2, 'controls remain reliable after recovery');
    conn.dataChannel.bufferedAmount = 0;
    const next = new ArrayBuffer(35); link.sendFast(next);
    assert.equal(conn.sent.at(-1), next, 'fallback resumes after drain');
    assert.equal(link.trafficDiagnostics.fastStallRecoveries, 1, 'retirement counted once');
  }
  {
    now = 1000;
    const { conn, link, fast } = fastLink();
    link.sendFast(packet);
    now = 1200; fast.bufferedAmount = 16; link.sendFast(packet);
    now = 1400; link.sendFast(packet);
    assert.equal(link.fastOpen, true, 'partial progress restarts stall interval');
    assert.equal(conn.sent.length, 0);
    fast.bufferedAmount = 0; link.sendFast(packet);
    now = 1600; link.sendFast(packet);
    assert.equal(link.fastOpen, true, 'full drain restarts stall interval');
    fast.close();
    const replacement = channel();
    conn.peerConnection.ondatachannel({ channel: replacement });
    now = 1800; link.sendFast(packet);
    now = 2000; link.sendFast(packet);
    assert.equal(link.fastOpen, true, 'channel switch resets prior stall interval');
    assert.equal(link.trafficDiagnostics.fastStallRecoveries, 0);
  }
  {
    now = 3000;
    const { conn, link, fast } = fastLink();
    link.sendFast(packet);
    conn.bufferSize = 1;
    now = 3251; link.sendFast(packet);
    assert.equal(fast.readyState, 'closed');
    assert.equal(conn.sent.length, 0, 'retirement still honors PeerJS backlog');
    conn.bufferSize = 0; conn.dataChannel.bufferedAmount = 1;
    link.sendFast(packet);
    assert.equal(conn.sent.length, 0, 'retirement still honors browser backlog');
    conn.dataChannel.bufferedAmount = 0;
    const fresh = new ArrayBuffer(36); link.sendFast(fresh);
    assert.deepEqual(conn.sent, [fresh], 'queue drain admits only newest packet');
  }
  console.log('Transport regression: 8 scenarios passed (queue bounds, timed stall recovery, progress reset, controls, send races, handshake/fallback).');
} finally {
  if (originalNow) Object.defineProperty(performance, 'now', originalNow);
  else delete performance.now;
  await rm(outDir, { recursive: true, force: true });
}
