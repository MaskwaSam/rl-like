import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

// Build both versions of the actual methods, instrumenting only selection/encoding counts.
// SocketLink stays private in production; this plugin supplies a QA-only export.
const baseline = '0998166fba124cb4ea3fea87ecde2aa3c14ac0a0';
const root = fileURLToPath(new URL('../', import.meta.url));
const mock = fileURLToPath(new URL('./mock-transport.ts', import.meta.url));
globalThis.__inputPreflightCounts = {};
async function loadVersion(version) {
  globalThis.__inputPreflightCounts[version] = { selections: 0, encodes: 0 };
  const counter = `globalThis.__inputPreflightCounts.${version}`;
  const outDir = `.qa-build/server-input-preflight/${version}`;
  await build({ root, configFile: false, logLevel: 'error', plugins: [{
    name: `server-input-preflight-${version}`, enforce: 'pre',
    resolveId(source, importer) {
      if (source === root + 'qa/input-preflight-entry.ts') return '\0input-preflight-entry';
      if (source === './transport' && /src\/net\/client\.ts$/.test(importer ?? '')) return mock;
    },
    load(id) {
      if (id === '\0input-preflight-entry') return `
        export { ClientSession } from ${JSON.stringify(root + 'src/net/client.ts')};
        export { SocketLink } from ${JSON.stringify(root + 'src/net/server-session.ts')};
        export { encodeInputs, encodePing, encodePong } from ${JSON.stringify(root + 'src/net/protocol.ts')};
        export { Game, FREE_PLAY_CONFIG } from ${JSON.stringify(root + 'src/sim/game.ts')};
        export { ByteReader } from ${JSON.stringify(root + 'src/sim/state.ts')};`;
    },
    transform(source, id) {
      const relative = id.startsWith(root) ? id.slice(root.length) : '';
      if (!['src/net/client.ts', 'src/net/server-session.ts', 'src/net/protocol.ts'].includes(relative)) return;
      if (version === 'baseline') source = execFileSync('git', ['show', `${baseline}:${relative}`], { cwd: root, encoding: 'utf8' });
      if (relative.endsWith('/server-session.ts')) source += '\nexport { SocketLink };\n';
      if (relative.endsWith('/client.ts')) {
        const selection = 'const ticks = [...this.pending.keys()]';
        assert.ok(source.includes(selection), 'selection instrumentation anchor');
        source = source.replace(selection, `${counter}.selections++;\n    ${selection}`);
      }
      if (relative.endsWith('/protocol.ts')) {
        const encoder = 'export function encodeInputs(firstTick: number, inputs: CarInput[]): ArrayBuffer {';
        assert.ok(source.includes(encoder), 'encoder instrumentation anchor');
        source = source.replace(encoder, `${encoder}\n ${counter}.encodes++;`);
      }
      return source;
    },
  }], build: { ssr: root + 'qa/input-preflight-entry.ts', outDir, emptyOutDir: true, target: 'esnext', minify: false,
    rollupOptions: { output: { entryFileNames: 'entry.js' } } } });
  return import(pathToFileURL(root + outDir + '/entry.js').href);
}
const versions = { baseline: await loadVersion('baseline'), current: await loadVersion('current') };
let now = 0;
const nowDescriptor = Object.getOwnPropertyDescriptor(performance, 'now');
const originalWebSocket = globalThis.WebSocket;
const originalLocation = globalThis.location;
Object.defineProperty(performance, 'now', { configurable: true, value: () => now });
globalThis.location = { protocol: 'https:', host: 'qa.invalid' };
class FakeWebSocket {
  static OPEN = 1;
  static instances = [];
  readyState = 1;
  bufferedAmount = 0;
  packets = [];
  trace = [];
  constructor() { FakeWebSocket.instances.push(this); queueMicrotask(() => this.onopen?.()); }
  send(packet) {
    const copy = typeof packet === 'string' ? packet : Buffer.from(packet);
    this.packets.push(copy);
    this.trace.push({ at: now, packet: copy });
  }
  close() { this.readyState = 3; }
  control(message) { this.onmessage({ data: JSON.stringify(message) }); }
}
globalThis.WebSocket = FakeWebSocket;
const input = tick => ({ throttle: (tick % 3) - 1, steer: tick % 2 ? .5 : -.5,
  pitch: 0, yaw: 0, roll: 0, jump: tick % 7 === 0, boost: tick % 5 === 0,
  handbrake: false });
const counts = version => ({ ...globalThis.__inputPreflightCounts[version] });
async function fixture(version, realGame = false) {
  const api = versions[version];
  const link = await api.SocketLink.open();
  const ws = FakeWebSocket.instances.at(-1);
  const client = new api.ClientSession(null, link, 'TEST');
  client.localId = 0;
  if (realGame) {
    await client.startGame({ ...api.FREE_PLAY_CONFIG, seed: 41 });
    client.game.addCar(0, 'blue');
    client.synced = true;
  } else client.game = { destroy() {} };
  return { api, link, ws, client, close() { client.game?.destroy(); client.game = null; link.close(); } };
}
function binary(ws) { return ws.packets.filter(p => typeof p !== 'string'); }
function fill(client, first, last) { for (let t = first; t <= last; t++) client.pending.set(t, input(t)); }
function packetShape(packet) {
  return { epoch: packet.readUInt32LE(0), type: packet[4], first: packet.readUInt32LE(5), count: packet[9] };
}
const results = [];
try {
  for (const fps of [120, 240]) {
    const runs = {};
    for (const version of Object.keys(versions)) {
      now = 1000;
      const f = await fixture(version, true);
      const before = counts(version);
      for (let frame = 0; frame < fps * 2; frame++) {
        now = 1000 + frame * 1000 / fps;
        f.client.update(input(frame), 1 / fps, false);
      }
      runs[version] = { packets: binary(f.ws), trace: f.ws.trace, ticks: f.client.game.tick,
        pending: [...f.client.pending], selections: counts(version).selections - before.selections,
        encodes: counts(version).encodes - before.encodes };
      f.close();
    }
    assert.deepEqual(runs.current.packets, runs.baseline.packets, `${fps} FPS exact wire bytes/timing order`);
    assert.deepEqual(runs.current.trace, runs.baseline.trace, `${fps} FPS exact send timestamps`);
    assert.deepEqual(runs.current.pending, runs.baseline.pending, 'prediction inputs unchanged');
    assert.equal(runs.current.ticks, runs.baseline.ticks, 'local prediction keeps stepping');
    const inputPackets = runs.current.packets.filter(p => p[4] === 1).length;
    assert.ok(runs.current.encodes >= inputPackets, 'near-deadline preparation may still face the final send gate');
    assert.ok(runs.current.selections <= runs.current.encodes + 1, 'only an initial empty pending set may add a selection');
    assert.ok(runs.baseline.encodes > runs.current.encodes);
    results.push({ fps, baselineSelections: runs.baseline.selections, selections: runs.current.selections,
      baselineEncodes: runs.baseline.encodes, encodes: runs.current.encodes,
      selectionSkips: runs.baseline.selections - runs.current.selections,
      encodeSkips: runs.baseline.encodes - runs.current.encodes, inputPackets, predictionTicks: runs.current.ticks });
  }

  const traces = {};
  for (const version of Object.keys(versions)) {
    now = 0;
    const f = await fixture(version);
    const { client, link, ws, api } = f;
    const before = counts(version);
    fill(client, 0, 79);
    client.sendInputs(); // Existing first-input-at-zero pacing policy is preserved.
    now = 100;
    ws.readyState = 3;
    if (version === 'current') assert.equal(link.canSendInputs(), false);
    for (let i = 0; i < 20; i++) client.sendInputs();
    ws.readyState = 1; ws.bufferedAmount = 65537;
    if (version === 'current') assert.equal(link.canSendInputs(), false);
    for (let i = 0; i < 20; i++) client.sendInputs();
    if (version === 'current') assert.deepEqual(counts(version), before, 'closed/backpressure skip selection and encoding');
    assert.equal(binary(ws).length, 0);
    const blockedCounts = counts(version);
    results.push({ scenario: 'initial pacing + 20 closed + 20 backpressured', version,
      selections: blockedCounts.selections - before.selections, encodes: blockedCounts.encodes - before.encodes });
    ws.bufferedAmount = 65536;
    if (version === 'current') {
      assert.equal(link.canSendInputs(), true);
      assert.equal(link.canSendInputs(), true, 'preflight must not consume pacing');
    }
    client.sendInputs(); // Drain at the inclusive buffer boundary, newest 32 inputs.
    assert.deepEqual(packetShape(binary(ws).at(-1)), { epoch: 0, type: 1, first: 48, count: 32 });
    const last = link.lastInputAt;
    now = last + 1000 / 60 - 1e-8;
    if (version === 'current') assert.equal(link.canSendInputs(), true, 'near-deadline preparation has headroom');
    client.sendInputs();
    assert.equal(binary(ws).filter(p => p[4] === 1).length, 1, 'headroom does not allow an early packet');
    link.sendFast(api.encodePing(now)); link.sendFast(api.encodePong(now));
    assert.equal(link.lastInputAt, last, 'ping/pong do not consume pacing');
    // Use an exactly representable interval endpoint to test strict <, without rounding ambiguity.
    link.lastInputAt = 0; now = 1000 / 60;
    if (version === 'current') assert.equal(link.canSendInputs(), true, 'inclusive pacing boundary');
    client.sendInputs();
    assert.equal(binary(ws).filter(p => p[4] === 1).length, 2, 'exact 60 Hz boundary accepted');
    now = 200;
    client.ackedInputTick = 75;
    client.sendInputs();
    assert.deepEqual(packetShape(binary(ws).at(-1)), { epoch: 0, type: 1, first: 76, count: 4 });
    client.ackedInputTick = 79; now = 250; client.sendInputs();
    assert.equal(binary(ws).filter(p => p[4] === 1).length, 3, 'all ACKed inputs produce no packet');
    client.ackedInputTick = -1; client.pending.clear();
    fill(client, 10, 11); fill(client, 13, 14); now = 300; client.sendInputs();
    assert.equal(packetShape(binary(ws).at(-1)).count, 2, 'existing gap behavior retained');
    // Direct callers and a change between preflight and send must still face every final gate.
    now = 400;
    if (version === 'current') assert.equal(link.canSendInputs(), true);
    ws.bufferedAmount = 65537; link.sendFast(api.encodeInputs(0, [input(0)]));
    ws.bufferedAmount = 0; ws.readyState = 3; link.sendFast(api.encodeInputs(0, [input(0)]));
    ws.readyState = 1; link.lastInputAt = now; link.sendFast(api.encodeInputs(0, [input(0)]));
    assert.equal(binary(ws).filter(p => p[4] === 1).length, 4, 'sendFast retains authoritative guards');
    traces[version] = ws.trace;
    f.close();
  }
  assert.deepEqual(traces.current, traces.baseline, 'drain/boundary/ACK/gap/direct-call differential');

  // Real time advances while inputs are prepared. A preflight just before the
  // deadline must not defer a packet that the existing final gate would send.
  const boundaryTraces = {};
  for (const version of Object.keys(versions)) {
    now = 1000;
    const f = await fixture(version);
    fill(f.client, 0, 31);
    f.link.lastInputAt = 1000;
    now += 1000 / 60 - 0.1;
    const keys = f.client.pending.keys.bind(f.client.pending);
    f.client.pending.keys = () => { now += 0.2; return keys(); };
    f.client.sendInputs();
    boundaryTraces[version] = f.ws.trace;
    f.close();
  }
  assert.equal(boundaryTraces.baseline.length, 1, 'boundary fixture crosses the deadline during preparation');
  assert.deepEqual(boundaryTraces.current, boundaryTraces.baseline, 'preparation crossing the deadline sends this frame');

  const lifecycle = {};
  for (const version of Object.keys(versions)) {
    now = 1000;
    const f = await fixture(version, true);
    const { client, link, ws, api } = f;
    fill(client, 0, 79);
    // Exercise production snapshot ACK and pruning, with a matching empty-remote fixture.
    client.game.tick = 50;
    client.game.addCar(0, 'blue');
    client.recordHistory(50);
    const state = api.Game.decode(new api.ByteReader(client.game.snapshotBytes()));
    client.onSnapshot(state, 60);
    assert.equal(client.ackedInputTick, 60);
    assert.ok([...client.pending.keys()].every(t => t >= 50), 'production snapshot pruning');
    client.sendInputs();
    assert.equal(packetShape(binary(ws).at(-1)).first, 61);
    // A real startGame clears old inputs/ACKs, while the socket start control updates epoch.
    // Install only the client start handler as a no-op so we can await production startGame ourselves.
    link.onCtrl = () => {};
    ws.control({ t: 'start', epoch: 7, config: api.FREE_PLAY_CONFIG });
    await client.startGame(api.FREE_PLAY_CONFIG);
    assert.equal(client.pending.size, 0); assert.equal(client.ackedInputTick, -1);
    fill(client, 0, 2); now = 1100; client.sendInputs();
    assert.deepEqual(packetShape(binary(ws).at(-1)), { epoch: 7, type: 1, first: 0, count: 3 });
    let received = 0; link.onFast = () => received++;
    const incoming = epoch => { const p = new Uint8Array(5); new DataView(p.buffer).setUint32(0, epoch, true); p[4] = 3; return p.buffer; };
    ws.onmessage({ data: incoming(6) }); ws.onmessage({ data: incoming(7) });
    assert.equal(received, 1, 'stale match epoch rejected');
    link.sendCtrl({ t: 'hello', name: 'QA', version: 1, dodgeDeadzone: .5, body: 0 });
    const setTimeoutOriginal = globalThis.setTimeout;
    let reconnect;
    globalThis.setTimeout = (callback, delay) => { assert.equal(delay, 1000); reconnect = callback; return 0; };
    ws.readyState = 3;
    try { ws.onclose({ code: 1006 }); } finally { globalThis.setTimeout = setTimeoutOriginal; }
    const before = counts(version);
    client.sendInputs();
    if (version === 'current') assert.deepEqual(counts(version), before, 'reconnect gap skips work');
    reconnect(); await Promise.resolve(); await Promise.resolve();
    const replacement = FakeWebSocket.instances.at(-1);
    assert.ok(replacement.packets.some(p => typeof p === 'string' && JSON.parse(p).t === 'hello'), 'reconnect replays hello');
    now = 1200; client.sendInputs();
    assert.equal(packetShape(binary(replacement).at(-1)).epoch, 7);
    lifecycle[version] = [...ws.trace, ...replacement.trace];
    f.close();
  }
  assert.deepEqual(lifecycle.current, lifecycle.baseline, 'snapshot/rematch/reconnect exact packets');

  // An absent optional hook follows the old selection/encoding path (e.g. WebRTC).
  now = 2000;
  const f = await fixture('current');
  fill(f.client, 0, 40);
  f.link.canSendInputs = undefined;
  const before = counts('current');
  for (let i = 0; i < 10; i++) f.client.sendInputs();
  assert.equal(counts('current').selections - before.selections, 10);
  assert.equal(counts('current').encodes - before.encodes, 10);
  assert.equal(binary(f.ws).length, 1, 'fallback still uses authoritative send gate');
  f.close();
  console.log(JSON.stringify({ baseline, results }, null, 2));
  console.log('PASS exact baseline packets; non-consuming readiness; closed/backpressure/drain; 60 Hz and 64 KiB boundaries; ping/pong; direct/racing calls; ACK/pruning; rematch epochs; reconnect; absent-hook fallback');
} finally {
  if (nowDescriptor) Object.defineProperty(performance, 'now', nowDescriptor);
  else delete performance.now;
  globalThis.WebSocket = originalWebSocket;
  globalThis.location = originalLocation;
  delete globalThis.__inputPreflightCounts;
}
