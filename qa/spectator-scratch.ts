import assert from 'node:assert/strict';
import { Game, FREE_PLAY_CONFIG } from '../src/sim/game';
import { EMPTY_INPUT } from '../src/input/types';
import { SpectatorSession } from '../src/net/spectator';
// Resolved to git show 29cebba:src/net/spectator.ts by this suite's Vite plugin.
// @ts-expect-error test-only virtual baseline
import { SpectatorSession as BaselineSession } from 'spectator-scratch:baseline';
import { encodeSnapshot, type CtrlMsg } from '../src/net/protocol';
import type { GameLink } from '../src/net/channel';
import { TICK_DT } from '../src/sim/rl';

const blank = () => ({ maps: 0, inputMaps: 0, bodies: 0, copies: 0 });
const metrics = { baseline: blank(), candidate: blank() };
(globalThis as any).__spectatorScratchMetrics = metrics;
let now = 1000, comparisons = 0, epoch = 1;
const descriptor = Object.getOwnPropertyDescriptor(performance, 'now');
Object.defineProperty(performance, 'now', { configurable: true, value: () => now });
function makeLink(): GameLink {
  const link: GameLink = {
    onCtrl: null, onFast: null, onClose: null,
    sendCtrl(msg) { if (msg.t === 'spectate') queueMicrotask(() => link.onCtrl?.({ t: 'welcome' } as CtrlMsg)); },
    sendFast() {}, close() {},
  };
  return link;
}
const links = [makeLink(), makeLink()];
const viewers: SpectatorSession[] = [await BaselineSession.createOnLink(links[0], 'SCRATCH'), await SpectatorSession.createOnLink(links[1], 'SCRATCH')];
const candidate = viewers[1] as any;
const config = { ...FREE_PLAY_CONFIG, countdown: .04 };
const source = await Game.create(config);
source.phase = 'play';
source.countdown = 0;
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
function state(v: SpectatorSession) {
  const g = v.game!;
  return {
    bytes: [...new Uint8Array(g.snapshotBytes())],
    curr: { ...g.curr, cars: [...g.curr.cars] }, prev: { ...g.prev, cars: [...g.prev.cars] },
    render: v.carRenderStates(), ballOffset: v.ballOffset(), ballVisible: g.ballVisible,
    ready: v.ready, alpha: v.alpha, stats: v.stats, events: v.events,
    renderTick: (v as any).renderTick, latestAt: (v as any).latestAt,
    pending: (v as any).pending, lastSnapshotTick: (v as any).lastSnapshotTick,
  };
}
function compare(label: string) {
  assert.deepStrictEqual(state(viewers[1]), state(viewers[0]), label);
  const g = viewers[1].game!;
  const live = [...g.curr.cars.values(), ...g.prev.cars.values(), g.curr.ball, g.prev.ball];
  for (const map of [candidate.oldCars, candidate.oldPrevCars]) {
    assert(map.size <= g.cars.size, `${label}: scratch roster retained removed IDs`);
    for (const [id, body] of map) {
      assert(g.cars.has(id), `${label}: removed scratch ID`);
      assert(!live.includes(body), `${label}: scratch aliases game/render body`);
    }
  }
  assert(!live.includes(candidate.oldBall) && !live.includes(candidate.oldPrevBall), `${label}: ball aliases scratch`);
  assert.equal(candidate.emptyInputs.size, 0, 'Game.step mutated empty input map');
  comparisons++;
}
function send(tick: number, packetEpoch = epoch) {
  source.tick = tick;
  const packet = encodeSnapshot(source.snapshotBytes(), packetEpoch, now);
  for (const link of links) link.onFast!(packet);
}
function frame(dt = 0, label = 'frame') {
  now += dt * 1000;
  for (const v of viewers) v.update(dt);
  compare(label);
}
function ahead(ticks: number) {
  for (const v of viewers) {
    for (let i = 0; i < ticks; i++) v.game!.step(new Map(), TICK_DT);
    (v as any).renderTick = v.game!.tick - .35;
  }
}
function correction(label: string, replay: number, change = () => {}) {
  const next = Math.max((viewers[0] as any).lastSnapshotTick + 2, viewers[0].game!.tick - replay);
  const old = viewers[0].game!.tick;
  ahead(Math.max(0, next + replay - old));
  change();
  send(next); frame(0, label);
}
function resetMetrics() { metrics.baseline = blank(); metrics.candidate = blank(); }
function measure(label: string, run: () => void, copies: number, corrections = 100, steps = 0) {
  resetMetrics(); run();
  assert.deepStrictEqual(metrics.baseline, { maps: 2 * corrections, inputMaps: steps, bodies: 18 * corrections, copies: 18 * corrections }, `${label}: baseline work`);
  assert.equal(metrics.candidate.maps + metrics.candidate.inputMaps + metrics.candidate.bodies, 0, `${label}: steady-state allocations`);
  assert.equal(metrics.candidate.copies, copies, `${label}: capture work`);
  console.log(`ALLOCATION ${label} ${JSON.stringify(metrics)}`);
}
try {
  for (let id = 0; id < 8; id++) {
    const car = source.addCar(id, id % 2 ? 'orange' : 'blue');
    car.lastInput = { ...EMPTY_INPUT, throttle: .7, steer: .15 * (id % 3 - 1) };
  }
  for (const link of links) link.onCtrl!({ t: 'start', config, epoch });
  await flush(); send(1); compare('first snapshot');
  correction('warm scratch same tick', 0);
  assert.deepStrictEqual(metrics.candidate, { maps: 2, inputMaps: 1, bodies: 18, copies: 18 }, 'bounded cold scratch allocation');
  // Same-tick corrections need both snapshots; replay needs only the current transforms.
  measure('8 cars / 100 same-tick corrections', () => {
    for (let i = 0; i < 100; i++) correction('same-tick smoothing', 0, () => {
      const body = source.cars.get(0)!.body;
      body.setTranslation({ ...body.translation(), x: Math.sin(i) * .2 }, true);
    });
  }, 1800);
  measure('8 cars / 100 replay corrections (2 ticks)', () => {
    for (let i = 0; i < 100; i++) correction('replay smoothing', 2);
  }, 900, 100, 200);
  measure('8 cars / 100 newer-authority corrections', () => {
    for (let i = 0; i < 100; i++) { send(viewers[0].game!.tick + 3); frame(0, 'newer authority'); }
  }, 0);
  measure('8 cars / replay cap exceeded', () => correction('31 tick gap', 31), 0, 1, 30);
  correction('exact 30 tick replay boundary', 30);
  correction('replay cap with roster removal', 31, () => { source.removeCar(7); });
  correction('restore roster after capped replay', 0, () => { source.addCar(7, 'orange'); });
  correction('teleport car and ball', 0, () => {
    source.cars.get(0)!.body.setTranslation({ x: 30, y: 4, z: 20 }, true);
    source.ball.setTranslation({ x: 20, y: 5, z: 10 }, true);
  });
  correction('goal and hidden ball', 0, () => {
    source.phase = 'goal'; source.goalPause = .02; source.score.blue = 1;
    source.lastGoal = 'blue'; source.lastGoalScorer = 0; source.lastGoalSpeed = 42;
  });
  correction('goal replay into countdown', 3);
  assert.equal(viewers[1].game!.phase, 'countdown', 'goal replay missed kickoff transition');
  correction('countdown', 0, () => { source.phase = 'countdown'; source.countdown = .02; });
  correction('countdown replay into play', 3);
  assert.equal(viewers[1].game!.phase, 'play', 'countdown replay missed play transition');
  correction('remove roster on comparable correction', 0, () => { source.removeCar(6); source.removeCar(7); });
  send(viewers[0].game!.tick + 5); frame(0, 'roster removal on newer authority');
  correction('re-add roster', 0, () => { source.addCar(6, 'blue'); source.addCar(7, 'orange'); });
  // Fresh scratch objects for returning IDs cannot share game storage, even after subsequent captures.
  correction('repeat captures after roster reuse', 0);
  source.removeCar(7); send(viewers[0].game!.tick + 5); frame(0, 'prune on non-comparable correction');
  source.addCar(7, 'orange');
  for (let i = 0; i < 160; i++) {
    source.step(new Map(), TICK_DT); source.step(new Map(), TICK_DT);
    const tick = Math.max(source.tick, (viewers[0] as any).lastSnapshotTick + 1);
    if (i % 7 !== 0) {
      if (i % 5 === 0) { send(tick); send(tick + 1); send(tick + 2); }
      else send(tick);
      send(tick - 1); send(999999, epoch - 1);
    }
    frame(1 / 60, 'loss/burst/prediction');
  }
  // Reset must discard scratch bodies and pending corrections, then reject old high ticks.
  send(viewers[0].game!.tick + 10);
  for (const link of links) link.onCtrl!({ t: 'end' });
  assert.equal(candidate.oldCars.size + candidate.oldPrevCars.size, 0, 'end retained scratch');
  epoch++;
  for (const link of links) link.onCtrl!({ t: 'start', config, epoch });
  assert.equal(candidate.oldCars.size + candidate.oldPrevCars.size, 0, 'start retained scratch');
  send(999999, epoch - 1); send(1);
  await flush(); compare('rematch startup');
  correction('rematch scratch population', 0);
  viewers.forEach(v => v.leave());
  assert.equal(candidate.oldCars.size + candidate.oldPrevCars.size, 0, 'leave retained scratch');
  console.log(`PASS ${comparisons} exact baseline comparisons: serialized game, curr/prev, render transforms/offsets, events, clocks and step statistics; scratch bounds, no aliases, empty input map unchanged`);
} finally {
  viewers.forEach(v => v.leave()); source.destroy();
  if (descriptor) Object.defineProperty(performance, 'now', descriptor);
  else delete (performance as any).now;
  delete (globalThis as any).__spectatorScratchMetrics;
}
