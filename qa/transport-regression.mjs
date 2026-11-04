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
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
let now = 0;
let nextTimer = 0;
const timers = new Map();
let scheduledTimers = 0;
function installClock() {
  globalThis.setTimeout = (callback, delay) => {
    const id = ++nextTimer;
    scheduledTimers++;
    timers.set(id, { callback, due: now + delay });
    return id;
  };
  globalThis.clearTimeout = id => timers.delete(id);
}
// Advance wall time and run only callbacks eligible at this turn's start.
// Advancing `now` directly models a long task with no event-loop opportunity.
function turn(elapsed = 50) {
  now += elapsed;
  const eligible = [...timers].filter(([, timer]) => timer.due <= now);
  for (const [id, timer] of eligible) {
    if (!timers.delete(id)) continue;
    timer.callback();
  }
}
function confirmStall() { for (let i = 0; i < 6; i++) turn(); }
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
  installClock();
  const links = [];
  const packet = new ArrayBuffer(32);
  function channel() {
    return {
      label: 'fast', readyState: 'open', bufferedAmount: 0, sent: [], closeCalls: 0,
      send(data) { this.sent.push(data); this.bufferedAmount += data.byteLength; },
      close() { this.closeCalls++; this.readyState = 'closed'; this.onclose?.(); },
    };
  }
  function connection() {
    return {
      open: true, bufferSize: 0, dataChannel: channel(), sent: [], events: {}, closeCalls: 0,
      peerConnection: { createdChannels: [], createDataChannel() {
        const ch = channel(); this.createdChannels.push(ch); return ch;
      } },
      on(name, fn) { this.events[name] = fn; },
      send(data) { this.sent.push(data); this.dataChannel.bufferedAmount += typeof data === 'string' ? data.length : data.byteLength; },
      close() {
        this.closeCalls++; this.open = false; this.dataChannel.close(); this.events.close?.();
        // Model the remote reliable channel's close event, including synchronous reentrancy.
        if (this.remote?.open) this.remote.events.close?.();
      },
    };
  }
  function fastLink() {
    const conn = connection(), link = new Link(conn, true), fast = channel();
    links.push(link);
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
    now = 251;
    assert.equal(link.fastOpen, true, 'same-task elapsed time is not stall evidence');
    confirmStall(); link.sendFast(fresh);
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
    turn(); turn(200);
    fast.bufferedAmount = 16; turn();
    for (let i = 0; i < 4; i++) turn();
    link.sendFast(packet);
    assert.equal(link.fastOpen, true, 'partial progress restarts stall interval');
    assert.equal(conn.sent.length, 0);
    fast.bufferedAmount = 0; link.sendFast(packet);
    turn(200); link.sendFast(packet);
    assert.equal(link.fastOpen, true, 'full drain restarts stall interval');
    fast.close();
    const replacement = channel();
    conn.peerConnection.ondatachannel({ channel: replacement });
    turn(200); link.sendFast(packet);
    turn(200); link.sendFast(packet);
    assert.equal(link.fastOpen, true, 'channel switch resets prior stall interval');
    assert.equal(link.trafficDiagnostics.fastStallRecoveries, 0);
  }
  {
    now = 3000;
    const { conn, link, fast } = fastLink();
    link.sendFast(packet);
    conn.bufferSize = 1;
    confirmStall(); link.sendFast(packet);
    assert.equal(fast.readyState, 'closed');
    assert.equal(conn.sent.length, 0, 'retirement still honors PeerJS backlog');
    conn.bufferSize = 0; conn.dataChannel.bufferedAmount = 1;
    link.sendFast(packet);
    assert.equal(conn.sent.length, 0, 'retirement still honors browser backlog');
    conn.dataChannel.bufferedAmount = 0;
    const fresh = new ArrayBuffer(36); link.sendFast(fresh);
    assert.deepEqual(conn.sent, [fresh], 'queue drain admits only newest packet');
  }
  for (const link of links) link.close();
  assert.equal(timers.size, 0, 'prior scenarios release watchdog timers on close');
  {
    now = 0;
    const { link, fast, conn } = fastLink();
    const scheduledBefore = scheduledTimers;
    link.sendFast(packet);
    now += 1000;
    for (let i = 0; i < 1000; i++) link.sendFast(packet);
    assert.equal(link.fastOpen, true, 'long same-task sends cannot retire a channel');
    assert.equal(scheduledTimers - scheduledBefore, 1, 'same-task sends share one timer');
    fast.bufferedAmount = 0;
    turn();
    assert.equal(timers.size, 0, 'drain stops the monitor');
    assert.equal(link.trafficDiagnostics.fastStallRecoveries, 0);
    assert.equal(conn.sent.length, 0);
    link.close();
  }
  {
    now = 0;
    const { link, fast } = fastLink();
    const scheduledBefore = scheduledTimers;
    link.sendFast(packet);
    for (let i = 0; i < 3; i++) {
      fast.bufferedAmount = 0;
      turn(16);
      link.sendFast(packet);
    }
    assert.equal(scheduledTimers - scheduledBefore, 1, 'drain and refill across frames reuse pending timer');
    fast.bufferedAmount = 0;
    turn();
    assert.equal(timers.size, 0);
    link.close();
  }
  {
    now = 0;
    const { link, fast } = fastLink();
    for (let i = 0; i < 8; i++) {
      link.sendFast(packet); // A sparse ping queues bytes synchronously.
      fast.bufferedAmount = 0;
      turn(1000);
      assert.equal(link.fastOpen, true, 'sparse pings that drain retain fast transport');
      assert.equal(timers.size, 0);
    }
    assert.equal(link.trafficDiagnostics.fastSubmitted, 8);
    link.close();
  }
  {
    now = 0;
    const { link, fast } = fastLink();
    link.sendFast(packet);
    turn(); // First independent baseline.
    for (let i = 0; i < 4; i++) turn(); // One sample short of retirement.
    turn(5000); // A long scheduling pause invalidates prior confirmation.
    assert.equal(link.fastOpen, true, 'scheduling pause invalidates even near-expired confirmation');
    fast.bufferedAmount = 16;
    turn(); // Partial drain resets accumulated nonprogress.
    for (let i = 0; i < 4; i++) turn();
    assert.equal(link.fastOpen, true, 'partial progress grants a full new interval');
    fast.bufferedAmount = 0;
    turn();
    assert.equal(link.fastOpen, true, 'delayed full drain prevents retirement');
    assert.equal(timers.size, 0);
    link.sendFast(packet);
    confirmStall();
    assert.equal(link.trafficDiagnostics.fastStallRecoveries, 1, 'persistent sampled congestion still retires');
    assert.equal(timers.size, 0, 'retirement stops monitoring');
    link.close();
  }
  {
    now = 0;
    const { link, conn, fast } = fastLink();
    link.sendFast(packet);
    const oldCallback = [...timers.values()][0].callback;
    const replacement = channel();
    conn.peerConnection.ondatachannel({ channel: replacement });
    link.sendFast(packet);
    const replacementCallback = [...timers.values()][0].callback;
    oldCallback();
    assert.equal(link.fastOpen, true, 'canceled old callback cannot retire replacement');
    assert.equal(timers.size, 1, 'old callback cannot disturb replacement timer');
    fast.onclose(); fast.onerror();
    assert.equal(link.fastOpen, true, 'old channel events cannot clear replacement');
    link.close();
    assert.equal(timers.size, 0, 'shutdown cancels pending monitor');
    replacementCallback(); oldCallback();
    turn(5000);
    assert.equal(link.fastOpen, false, 'late timer callbacks cannot revive terminal link');
    assert.equal(link.trafficDiagnostics.fastStallRecoveries, 0);
    assert.equal(timers.size, 0, 'late callbacks cannot schedule another monitor');
  }
  for (const terminal of ['disconnected', 'failed', 'closed', 'error', 'close', 'explicit']) {
    const { conn, link, fast } = fastLink();
    let closed = 0, controls = 0, packets = 0;
    link.onClose = () => {
      closed++;
      assert.equal(conn.open, false, 'reliable transport closes before notification');
      assert.equal(fast.readyState, 'closed', 'fast transport closes before notification');
      link.close(); // Application cleanup can reenter as well as transport callbacks.
    };
    link.onCtrl = () => controls++;
    link.onFast = () => packets++;
    conn.events.data(JSON.stringify({ t: 'fastready' }));
    conn.events.data(packet);
    conn.events.data(new Uint8Array(packet));
    fast.onmessage({ data: packet });
    assert.equal(controls, 1);
    assert.equal(packets, 3, 'all receive paths dispatch while live');

    if (terminal === 'explicit') link.close();
    else if (terminal === 'error' || terminal === 'close') conn.events[terminal]();
    else conn.events.iceStateChanged(terminal);
    assert.equal(link.closed, true, `${terminal} is terminal`);
    assert.equal(conn.closeCalls, 1, `${terminal} closes physical reliable transport once`);
    assert.equal(conn.dataChannel.readyState, 'closed');
    assert.equal(fast.closeCalls, 1, `${terminal} closes physical fast transport once`);

    conn.events.iceStateChanged('connected');
    link.start();
    link.sendCtrl({ t: 'fastready' });
    link.sendFast(packet);
    conn.events.data(JSON.stringify({ t: 'fastready' }));
    conn.events.data(packet);
    conn.events.data(new Uint8Array(packet));
    fast.onmessage({ data: packet });
    const late = channel();
    conn.peerConnection.ondatachannel({ channel: late });
    assert.equal(late.readyState, 'closed', 'late fast channel is closed instead of adopted');
    assert.equal(link.fastOpen, false, 'connected ICE cannot revive abandoned link');
    assert.equal(conn.sent.length, 0, 'closed link submits no control or gameplay traffic');
    assert.equal(fast.sent.length, 0);
    assert.equal(controls, 1, 'late control is ignored');
    assert.equal(packets, 3, 'late reliable, typed-array and fast payloads are ignored');
    for (let i = 0; i < 3; i++) {
      conn.events.close(); conn.events.error(); conn.events.iceStateChanged('failed');
      fast.onclose(); fast.onerror(); link.close();
    }
    assert.equal(closed, 1, `${terminal} notifies exactly once despite repeated/reentrant callbacks`);
    assert.equal(conn.closeCalls, 1);
    assert.equal(fast.closeCalls, 1);
  }
  {
    const conn = connection(), link = new Link(conn, false);
    link.close();
    link.start();
    conn.events.data(JSON.stringify({ t: 'fastready' }));
    assert.equal(conn.peerConnection.createdChannels.length, 0, 'late invitation cannot create client fast channel');
  }
  {
    const a = fastLink(), b = fastLink();
    a.conn.remote = b.conn; b.conn.remote = a.conn;
    let aClosed = 0, bClosed = 0;
    a.link.onClose = () => aClosed++;
    b.link.onClose = () => bClosed++;
    a.conn.events.iceStateChanged('disconnected');
    assert.equal(aClosed, 1);
    assert.equal(bClosed, 1, 'physical closure propagates to remote Link');
    for (const side of [a, b]) {
      assert.equal(side.link.closed, true);
      assert.equal(side.conn.closeCalls, 1, 'paired close callbacks do not recurse');
      assert.equal(side.fast.closeCalls, 1);
    }
  }
  {
    const { conn, link, fast } = fastLink();
    let closed = 0;
    fast.close = () => { fast.closeCalls++; fast.onclose(); throw new Error('fast close failed'); };
    conn.close = () => { conn.closeCalls++; conn.events.error(); throw new Error('reliable close failed'); };
    link.onClose = () => closed++;
    conn.events.iceStateChanged('failed');
    link.close();
    assert.equal(conn.closeCalls, 1, 'fast close failure does not prevent reliable close attempt');
    assert.equal(fast.closeCalls, 1);
    assert.equal(closed, 1, 'close failures do not suppress or duplicate notification');
  }
  assert.equal(timers.size, 0, 'suite leaves no watchdog timers');
  console.log('Transport regression: 22 scenarios passed (queue bounds, stall recovery, fallback, terminal lifecycle, late dispatch, paired closure, close failures).');
} finally {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
  if (originalNow) Object.defineProperty(performance, 'now', originalNow);
  else delete performance.now;
  await rm(outDir, { recursive: true, force: true });
}
