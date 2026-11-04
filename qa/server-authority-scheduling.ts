import assert from 'node:assert/strict';
import { RoomAuthority } from '../server/authority';
// Supplied from git-show by this test's Vite runner, not a checked-in baseline copy.
// @ts-expect-error virtual historical module
import { RoomAuthority as BaselineAuthority } from '../server/authority-baseline';
import { Game } from '../src/sim/game';
import { ByteReader } from '../src/sim/state';
import { TICK_DT } from '../src/sim/rl';
import { EMPTY_INPUT } from '../src/input/types';
import { encodeInputs, Packet, PROTOCOL_VERSION, type CtrlMsg } from '../src/net/protocol';

const counters = globalThis as typeof globalThis & { __authoritySchedulingEncodes: number };
let now = 1000;
const realNow = Object.getOwnPropertyDescriptor(performance, 'now');
const realRandom = Math.random;
Object.defineProperty(performance, 'now', { configurable: true, value: () => now });
Math.random = () => 0.314159;
let comparisons = 0;
let advances = 0;
let totalBaselineCaptures = 0, totalCandidateCaptures = 0;
let totalBaselineEncodes = 0, totalCandidateEncodes = 0;
const report: object[] = [];
const hello = (name: string) => ({ t: 'hello', name, version: PROTOCOL_VERSION, body: 0, dodgeDeadzone: .5 });
type Wire = { principal: string; epoch: number; bytes: ArrayBuffer };
type Sample = { captures: number; encodes: number; packets: Wire[]; ticks: number; snapshots: number };
class Harness {
  authority: RoomAuthority;
  packets: Wire[] = [];
  controls: { principal: string; message: CtrlMsg }[] = [];
  captures = 0;
  inputMaps = new Set<ReadonlyMap<number, unknown>>();
  state!: () => ArrayBuffer;
  constructor(Authority: typeof RoomAuthority) {
    this.authority = new Authority('owner', 2,
      (principal, message) => this.controls.push({ principal, message }),
      (principal, epoch, bytes) => this.packets.push({ principal, epoch, bytes }));
  }
  instrument() {
    const game = this.authority.game!;
    this.state = game.snapshotBytes.bind(game);
    game.snapshotBytes = () => { this.captures++; return this.state(); };
    // Check the actual input Map presented to every physics step, including after
    // slot removal/reuse. A stale Map entry need not affect a now-absent car yet.
    const step = game.step.bind(game);
    game.step = (inputs, dt) => {
      assert.ok(inputs instanceof Map, 'authority passes a per-slot input Map');
      this.inputMaps.add(inputs);
      assert.deepEqual([...inputs.keys()].sort(), [...game.cars.keys()].sort(), 'input slots match live cars');
      step(inputs, dt);
    };
  }
  advance(dt: number): Sample {
    this.packets = []; this.captures = 0; counters.__authoritySchedulingEncodes = 0;
    const { ticks, snapshots } = this.authority.metrics;
    this.authority.advance(dt);
    return { captures: this.captures, encodes: counters.__authoritySchedulingEncodes, packets: this.packets,
      ticks: this.authority.metrics.ticks - ticks, snapshots: this.authority.metrics.snapshots - snapshots };
  }
}
// Initialize the shared WASM module before starting two independent worlds.
const warmup = await Game.create();
warmup.destroy();
const baseline = new Harness(BaselineAuthority);
const candidate = new Harness(RoomAuthority);
const both = [baseline, candidate];
const equalState = (label: string) => {
  assert.equal(candidate.authority.epoch, baseline.authority.epoch, label + ': epoch');
  assert.deepEqual(candidate.controls, baseline.controls, label + ': control messages');
  if (baseline.authority.game) {
    assert.deepEqual(Buffer.from(candidate.state()), Buffer.from(baseline.state()), label + ': exact game bytes');
    assert.deepEqual(candidate.authority.game!.world.takeSnapshot(), baseline.authority.game.world.takeSnapshot(), label + ': exact Rapier world bytes');
    comparisons++;
  } else assert.equal(candidate.authority.game, null);
};
const start = async (action = 'start') => {
  for (const h of both) h.authority.control('owner', { t: 'room-command', action });
  for (let i = 0; i < 100 && both.some(h => !h.authority.game); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(both.every(h => h.authority.game), 'real Rapier authority started');
  for (const h of both) h.instrument();
  equalState(action);
};
const input = (principal: string, length: number, offset = 0, epoch?: number) => {
  const tick = baseline.authority.game!.tick + offset;
  const bytes = encodeInputs(tick, Array.from({ length }, (_, i) => ({ ...EMPTY_INPUT,
    throttle: principal === 'owner' ? 1 : -.7, steer: (i % 3 - 1) * .6, boost: i % 2 === 0,
    jump: i % 5 === 0, yaw: .3, pitch: -.2, roll: .1, airRoll: true, handbrake: i % 7 === 0 })));
  assert.equal(candidate.authority.packet(principal, epoch ?? candidate.authority.epoch, bytes),
    baseline.authority.packet(principal, epoch ?? baseline.authority.epoch, bytes));
};
const tickOf = (packet: Wire) => Game.decode(new ByteReader(packet.bytes.slice(9))).tick;
function advance(label: string, dt: number, recipients = ['owner', 'guest'], expectedSteps?: number) {
  const before = baseline.authority.game?.tick ?? 0;
  const b = baseline.advance(dt), c = candidate.advance(dt);
  advances++;
  assert.equal(c.ticks, b.ticks, label + ': physics ticks');
  if (expectedSteps !== undefined) assert.equal(c.ticks, expectedSteps, label + ': expected tick count');
  assert.equal(candidate.authority.metrics.droppedBacklogs, baseline.authority.metrics.droppedBacklogs, label + ': backlog');
  equalState(label);
  const due = b.captures > 0 && recipients.length > 0;
  assert.equal(c.captures, Number(due), label + ': at most one capture');
  assert.equal(c.snapshots, Number(due), label + ': emitted-batch metric');
  assert.equal(c.encodes, due ? recipients.length : 0, label + ': encoder calls');
  assert.equal(c.packets.length, c.encodes, label + ': wire count');
  assert.equal(b.encodes, b.captures * recipients.length, label + ': historical encoder work');
  assert.deepEqual(c.packets.map(p => p.principal), due ? recipients : [], label + ': no per-recipient burst');
  for (const p of c.packets) {
    assert.equal(new Uint8Array(p.bytes)[0], Packet.Snapshot);
    assert.equal(p.epoch, candidate.authority.epoch, label + ': wire epoch');
    assert.equal(tickOf(p), candidate.authority.game!.tick, label + ': freshest tick');
    assert.deepEqual(Buffer.from(p.bytes.slice(9)), Buffer.from(candidate.state()), label + ': transmitted game bytes');
    const lastBaseline = b.packets.findLast(q => q.principal === p.principal)!;
    // Ack and host-time fields must be identical even when the final tick is odd.
    assert.deepEqual(Buffer.from(p.bytes.slice(0, 9)), Buffer.from(lastBaseline.bytes.slice(0, 9)), label + ': ack/time header');
    if (tickOf(lastBaseline) === tickOf(p)) assert.deepEqual(Buffer.from(p.bytes), Buffer.from(lastBaseline.bytes), label + ': full packet');
  }
  totalBaselineCaptures += b.captures; totalCandidateCaptures += c.captures;
  totalBaselineEncodes += b.encodes; totalCandidateEncodes += c.encodes;
  return { label, from: before, to: candidate.authority.game?.tick, baselineCaptures: b.captures, candidateCaptures: c.captures,
    baselineEncodes: b.encodes, candidateEncodes: c.encodes, emittedTick: c.packets[0] ? tickOf(c.packets[0]) : null };
}
try {
  for (const h of both) { h.authority.admit('owner', hello('Owner')); h.authority.admit('guest', hello('Guest')); }
  await start();
  for (let i = 0; i < 480; i++) {
    now += TICK_DT * 1000;
    if (i % 16 === 0) { input('owner', 32); input('guest', 23); }
    const row = advance('120Hz cadence ' + i, TICK_DT, undefined, 1);
    if (i < 2) report.push(row);
  }
  assert.equal(candidate.authority.game!.phase, 'play', 'cadence extends past countdown into driven gameplay');
  assert.equal(candidate.authority.metrics.snapshots, 240, '60Hz opportunities over 480 physics ticks');
  for (let i = 0; i < 60; i++) {
    now += 1000 / 60;
    if (i % 8 === 0) { input('owner', 32); input('guest', 23); }
    advance('60Hz cadence ' + i, TICK_DT * 2, undefined, 2);
  }
  assert.equal(candidate.authority.metrics.snapshots, 300, '60Hz callbacks preserve all 60 snapshot opportunities');
  for (const ticks of [4, 6, 12]) {
    input('owner', 32); input('guest', 19);
    report.push(advance(`${ticks}-tick catch-up`, ticks * TICK_DT, undefined, ticks));
  }
  report.push(advance('zero dt', 0, undefined, 0));
  report.push(advance('negative dt', -1, undefined, 0));
  report.push(advance('partial dt', TICK_DT / 4, undefined, 0));
  advance('finish partial tick', TICK_DT * .75, undefined, 1);
  // Currently odd: cross an even boundary but finish odd, then do not resend it.
  report.push(advance('boundary then odd final tick', TICK_DT * 2, undefined, 2));
  assert.equal(candidate.authority.game!.tick % 2, 1);
  report.push(advance('no-step after due', 0, undefined, 0));
  report.push(advance('large dt clamp', 10, undefined, 12));
  // The public dt clamp normally prevents excess backlog. Inject an accumulated
  // backlog identically to exercise the existing defensive drop path as well.
  for (const h of both) (h.authority as unknown as { accumulator: number }).accumulator = .2;
  report.push(advance('defensive backlog drop', 0, undefined, 12));
  assert.equal(candidate.authority.metrics.droppedBacklogs, 1);
  now += 251;
  advance('stale input timeout', TICK_DT * 4);
  for (const h of both) h.authority.disconnect('guest');
  report.push(advance('one disconnected', TICK_DT * 6, ['owner'], 6));
  for (const h of both) h.authority.disconnect('owner');
  report.push(advance('all disconnected', TICK_DT * 12, [], 12));
  for (const h of both) h.authority.admit('owner', hello('Owner'));
  report.push(advance('owner rejoin', TICK_DT * 4, ['owner'], 4));
  assert.equal(new DataView(candidate.packets[0].bytes).getInt32(1, true), -1, 'rejoin clears ack');
  now += 30_001;
  report.push(advance('expire departed guest', TICK_DT * 4, ['owner'], 4));
  assert.deepEqual([...candidate.authority.game!.cars.keys()], [0]);
  for (const h of both) h.authority.admit('newcomer', hello('Newcomer'));
  input('newcomer', 13); input('owner', 27);
  report.push(advance('reuse departed slot', TICK_DT * 6, ['owner', 'newcomer'], 6));
  assert.deepEqual(candidate.packets.map(p => new DataView(p.bytes).getInt32(1, true)),
    [candidate.authority.game!.tick - 6 + 26, candidate.authority.game!.tick - 6 + 12], 'distinct per-player acknowledgements');
  for (const h of both) { h.authority.remove('newcomer'); h.authority.remove('owner'); }
  report.push(advance('empty roster', TICK_DT * 6, [], 6));
  for (const h of both) { h.authority.admit('owner', hello('Owner')); h.authority.admit('guest', hello('Guest')); }
  input('owner', 32);
  // Leave a fractional accumulator and queued inputs before resetting the match.
  advance('pre-reset partial', TICK_DT / 4);
  const epoch = candidate.authority.epoch;
  await start('reset');
  assert.equal(candidate.authority.epoch, epoch + 1);
  input('owner', 32, 0, epoch); // old epoch must be ignored, including ack
  report.push(advance('reset accumulator no-step', TICK_DT * .75, undefined, 0));
  report.push(advance('reset fresh snapshot', TICK_DT * 1.25, undefined, 2));
  assert.ok(candidate.packets.every(p => new DataView(p.bytes).getInt32(1, true) === -1), 'reset/stale epoch preserve cleared acks');
  input('owner', 17); input('guest', 9);
  report.push(advance('new epoch inputs', TICK_DT * 4, undefined, 4));
  for (const h of both) h.authority.control('owner', { t: 'room-command', action: 'end' });
  report.push(advance('ended no-op', .1, undefined, 0));
  // Start cancellation is asynchronous; an ended pending start must never install a game.
  for (const h of both) {
    h.authority.control('owner', { t: 'room-command', action: 'start' });
    h.authority.control('owner', { t: 'room-command', action: 'end' });
  }
  await new Promise(resolve => setImmediate(resolve));
  equalState('cancelled start');
  assert.equal(candidate.authority.game, null);
  await start();
  report.push(advance('start after cancellation', TICK_DT * 2, undefined, 2));
  for (const h of both) h.authority.destroy();
  report.push(advance('destroyed no-op', .1, [], 0));
  assert.equal(candidate.inputMaps.size, 1, 'one cleared input Map reused across ticks and match resets');
  assert.equal(baseline.inputMaps.size, baseline.authority.metrics.ticks, 'historical authority allocates an input Map per tick');
  console.table(report);
  console.log(JSON.stringify({ advances, physicsTicks: candidate.authority.metrics.ticks, baselineInputMaps: baseline.inputMaps.size, candidateInputMaps: candidate.inputMaps.size, exactGameAndRapierComparisons: comparisons,
    baselineCaptures: totalBaselineCaptures, candidateCaptures: totalCandidateCaptures,
    baselineEncodes: totalBaselineEncodes, candidateEncodes: totalCandidateEncodes }));
  console.log('PASS real Rapier baseline/candidate scheduling, exact state bytes, latest tick, no burst, lifecycle and per-player ack checks');
} finally {
  both.forEach(h => h.authority.destroy());
  Math.random = realRandom;
  if (realNow) Object.defineProperty(performance, 'now', realNow);
  else delete (performance as unknown as { now?: unknown }).now;
}
