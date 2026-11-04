/** Run with `node qa/heartbeat-admission.mjs`; exercises production Link with fake channels. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = await mkdtemp(join(tmpdir(), 'car-heartbeat-admission-'));
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
  function packet(type, bytes) {
    const buf = new ArrayBuffer(bytes);
    new Uint8Array(buf)[0] = type;
    return buf;
  }
  const ping = packet(3, 5), pong = packet(4, 5);
  const input = packet(1, 24), snapshot = packet(2, 4096);
  function channel() {
    return {
      label: 'fast', readyState: 'open', bufferedAmount: 0, sent: [], fail: false,
      send(data) {
        if (this.fail) throw new Error('send failed');
        this.sent.push(data);
        this.bufferedAmount += typeof data === 'string' ? data.length : data.byteLength;
      },
      close() { this.readyState = 'closed'; this.onclose?.(); },
    };
  }
  function setup(mode) {
    now = 0;
    const reliable = channel(), fast = channel();
    const conn = {
      open: true, bufferSize: 0, dataChannel: reliable, events: {},
      peerConnection: {},
      on(name, fn) { this.events[name] = fn; },
      send(data) { reliable.send(data); },
      close() { this.open = false; reliable.close(); this.events.close?.(); },
    };
    const link = new Link(conn, true);
    if (mode === 'fast') {
      link.start();
      reliable.sent.length = 0; reliable.bufferedAmount = 0;
      conn.peerConnection.ondatachannel({ channel: fast });
    }
    return { conn, link, fast, reliable, ch: mode === 'fast' ? fast : reliable };
  }
  let scenarios = 0;
  for (const mode of ['fast', 'fallback']) {
    for (const gameplay of [input, snapshot]) {
      for (const heartbeat of [ping, pong]) {
        for (const reverse of [false, true]) {
          const { link, ch, reliable } = setup(mode);
          const pair = reverse ? [gameplay, heartbeat] : [heartbeat, gameplay];
          pair.forEach(buf => link.sendFast(buf));
          assert.deepEqual(ch.sent, pair, `${mode}: heartbeat and gameplay coexist in either order`);
          assert.equal(ch.bufferedAmount, gameplay.byteLength + 5);
          for (let i = 0; i < 1000; i++) {
            link.sendFast(ping); link.sendFast(pong);
            link.sendFast(input); link.sendFast(snapshot);
          }
          assert.equal(ch.sent.length, 2, `${mode}: repeated calls cannot grow the pair`);
          assert.equal(link.trafficDiagnostics.droppedBackpressure, 4000);
          if (mode === 'fast') assert.equal(reliable.sent.length, 0, 'brief congestion does not spill');
          // Partial drain does not issue another allowance after the pair is spent.
          ch.bufferedAmount = 1;
          link.sendFast(ping); link.sendFast(gameplay);
          assert.equal(ch.sent.length, 2);
          ch.bufferedAmount = 0;
          link.sendFast(ping); link.sendFast(gameplay);
          assert.equal(ch.sent.length, 4, 'full drain permits a new pair');
          scenarios++;
        }
      }
    }
    {
      const { link, ch } = setup(mode);
      link.sendFast(input);
      for (let i = 0; i < 1000; i++) link.sendFast(snapshot);
      assert.equal(ch.sent.length, 1, 'gameplay cannot pair with gameplay');
      link.sendFast(ping);
      assert.deepEqual(ch.sent, [input, ping], 'gameplay does not starve heartbeat');
      scenarios++;
    }
    {
      const { link, ch } = setup(mode);
      link.sendFast(ping);
      for (let i = 0; i < 1000; i++) link.sendFast(pong);
      assert.equal(ch.sent.length, 1, 'heartbeat cannot pair with heartbeat');
      ch.bufferedAmount = 2;
      link.sendFast(input);
      assert.deepEqual(ch.sent, [ping, input], 'partial drain permits only the one companion');
      link.sendFast(snapshot);
      assert.equal(ch.sent.length, 2);
      scenarios++;
    }
    for (const malformed of [packet(3, 6), packet(4, 4), packet(0, 5)]) {
      const { link, ch } = setup(mode);
      link.sendFast(malformed); link.sendFast(input);
      assert.deepEqual(ch.sent, [malformed], 'unknown or malformed heartbeat grants no allowance');
      ch.bufferedAmount = 0;
      link.sendFast(input); link.sendFast(malformed);
      assert.deepEqual(ch.sent, [malformed, input], 'malformed heartbeat cannot consume a companion slot');
      scenarios++;
    }
    {
      const { link, ch } = setup(mode);
      const empty = new ArrayBuffer(0);
      link.sendFast(empty); link.sendFast(input); link.sendFast(empty);
      assert.deepEqual(ch.sent, [empty, input], 'empty payload grants no companion credit');
      scenarios++;
    }
    {
      const { link, fast, reliable } = setup(mode);
      link.sendFast(ping); link.sendFast(snapshot);
      for (let i = 1; i <= 1000; i++) {
        now = i * 10;
        link.sendFast(ping); link.sendFast(input); link.sendFast(snapshot);
      }
      assert.ok(fast.sent.length <= 2, 'sustained congestion bounds fast submissions');
      assert.ok(reliable.sent.length <= 2, 'sustained congestion bounds fallback submissions');
      assert.ok(reliable.bufferedAmount <= snapshot.byteLength + 5);
      scenarios++;
    }
    {
      const { link, ch } = setup(mode);
      ch.bufferedAmount = 1;
      for (let i = 0; i < 100; i++) {
        link.sendFast(ping); link.sendFast(input);
      }
      assert.equal(ch.sent.length, 0, 'external congestion grants no heartbeat allowance');
      scenarios++;
    }
    {
      const { conn, link, ch, reliable } = setup(mode);
      link.sendFast(ping);
      ch.fail = true;
      if (mode === 'fast') reliable.fail = true;
      link.sendFast(input);
      assert.equal(ch.sent.length, 1);
      const errors = link.trafficDiagnostics.sendErrors;
      assert.equal(errors, mode === 'fast' ? 2 : 1, 'send failures are counted');
      ch.fail = false; reliable.fail = false;
      // Failed companion consumes credit even if bufferedAmount did not change.
      link.sendFast(input);
      assert.equal(ch.sent.length, 1, 'failed send cannot leave reusable pair credit');
      if (mode === 'fallback') assert.equal(link.trafficDiagnostics.sendErrors, errors);
      conn.open = false; ch.readyState = 'closed';
      link.sendFast(input);
      assert.equal(link.trafficDiagnostics.droppedUnavailable, 1);
      scenarios++;
    }
    {
      const { link, ch } = setup(mode);
      link.sendFast(ping); link.close(); link.sendFast(input);
      assert.deepEqual(ch.sent, [ping], 'terminal link cannot spend companion credit');
      assert.equal(link.trafficDiagnostics.droppedUnavailable, 1);
      scenarios++;
    }
  }
  {
    const { conn, link, ch } = setup('fallback');
    link.sendFast(ping); conn.bufferSize = 1;
    link.sendFast(input);
    assert.deepEqual(ch.sent, [ping], 'PeerJS pending messages block even a companion');
    link.sendCtrl({ t: 'fastready' });
    assert.equal(ch.sent.length, 2, 'reliable controls bypass admission');
    conn.bufferSize = 0; ch.bufferedAmount = 5;
    link.sendFast(input);
    assert.equal(ch.sent.length, 2, 'control invalidates prior heartbeat credit even after partial drain');
    ch.bufferedAmount = 0;
    link.sendFast(ping); link.sendFast(input);
    assert.equal(ch.sent.length, 4, 'both queues drained restores pairing');
    scenarios++;
  }
  {
    const { conn, link, fast, reliable } = setup('fast');
    link.sendFast(ping); fast.close();
    reliable.bufferedAmount = 1;
    link.sendFast(input);
    assert.equal(reliable.sent.length, 0, 'fast allowance never transfers to congested fallback');
    reliable.bufferedAmount = 0;
    link.sendFast(ping); link.sendFast(snapshot);
    assert.deepEqual(reliable.sent, [ping, snapshot]);
    conn.bufferSize = 1; reliable.bufferedAmount = 0;
    link.sendFast(ping);
    assert.equal(reliable.sent.length, 2, 'PeerJS backlog also blocks a new heartbeat');
    scenarios++;
  }
  console.log(`Heartbeat admission: ${scenarios} scenarios passed (production Link; no network).`);
} finally {
  if (originalNow) Object.defineProperty(performance, 'now', originalNow);
  else delete performance.now;
  await rm(outDir, { recursive: true, force: true });
}
