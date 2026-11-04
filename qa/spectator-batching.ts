import { Game, FREE_PLAY_CONFIG } from '../src/sim/game';
import { ByteReader } from '../src/sim/state';
import { Packet, encodeSnapshot, type CtrlMsg } from '../src/net/protocol';
import { SpectatorSession } from '../src/net/spectator';
import type { GameLink } from '../src/net/channel';

const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
let now = 1000;
const nowDescriptor = Object.getOwnPropertyDescriptor(performance, 'now');
Object.defineProperty(performance, 'now', { configurable: true, value: () => now });
let decodes = 0, applies = 0, inputs = 0;
const decode = Game.decode, apply = Game.prototype.applyState, create = Game.create;
Game.decode = (r: ByteReader) => { decodes++; return decode(r); };
Game.prototype.applyState = function (s) { applies++; return apply.call(this, s); };
const link: GameLink = {
  onCtrl: null, onFast: null, onClose: null,
  sendCtrl(msg) { if (msg.t === 'spectate') queueMicrotask(() => link.onCtrl?.({ t: 'welcome' } as CtrlMsg)); },
  sendFast(buf) { if (new Uint8Array(buf)[0] === Packet.Input) inputs++; },
  close() { link.onClose?.(); },
};
const viewer = await SpectatorSession.createOnLink(link, 'BATCH');
const source = await create(FREE_PLAY_CONFIG);
source.addCar(0, 'blue');
let started = 0;
viewer.onMatchStarted = () => started++;
const packet = (tick: number, epoch = 1) => { source.tick = tick; return encodeSnapshot(source.snapshotBytes(), epoch, 0); };
const send = (tick: number, epoch = 1) => link.onFast!(packet(tick, epoch));
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const counts = () => { decodes = 0; applies = 0; };
try {
  // The inexpensive layout check must track the actual serializer, including changing rosters.
  const layout = await create(FREE_PLAY_CONFIG);
  const countOffset = layout.snapshotBytes().byteLength - 1;
  for (let cars = 0; cars <= 8; cars++) {
    if (cars) layout.addCar(cars - 1, cars % 2 ? 'blue' : 'orange');
    const bytes = layout.snapshotBytes();
    check(Game.isCompleteSnapshot(bytes), `serializer layout rejected ${cars} cars`);
    for (let end = 0; end < bytes.byteLength; end++) {
      check(!Game.isCompleteSnapshot(bytes.slice(0, end)), `truncated ${cars}-car record accepted at ${end}`);
    }
    const wrongCount = bytes.slice(0);
    new DataView(wrongCount).setUint8(countOffset, cars + 1);
    check(!Game.isCompleteSnapshot(wrongCount), 'incomplete advertised roster accepted');
    const trailing = new Uint8Array(bytes.byteLength + 1);
    trailing.set(new Uint8Array(bytes));
    check(!Game.isCompleteSnapshot(trailing.buffer), 'unexpected trailing record bytes accepted');
  }
  layout.destroy();
  console.log('PASS complete wire layout for 0–8 cars; every truncation and invalid count rejected');

  // Hold creation so several packets really arrive before the async world exists.
  let release!: (g: Game) => void;
  Game.create = () => new Promise(resolve => { release = resolve; });
  link.onCtrl!({ t: 'start', config: FREE_PLAY_CONFIG, epoch: 1 });
  counts();
  send(1); send(2); send(3);
  check(decodes === 0, 'startup decoded before creation');
  now = 1050;
  release(await create(FREE_PLAY_CONFIG));
  await flush();
  Game.create = create;
  check(viewer.ready && started === 1 && viewer.game!.tick === 3, 'startup did not become ready without update');
  check(decodes === 1 && applies === 1, 'startup did not coalesce raw snapshots');
  check((viewer as any).latestAt === 1000, 'startup lost actual arrival timestamp');
  console.log('PASS raw startup batching and readiness without update');

  counts();
  for (let tick = 4; tick <= 9; tick++) { now++; send(tick); }
  check(decodes === 0 && applies === 0 && viewer.game!.tick === 3, 'packet callback reconciled a ready session');
  for (let i = 0; i < 6; i++) send(9);
  send(8); send(10000, 0);
  check(decodes === 0, 'pending duplicate/stale/old epoch decoded');
  now += 100;
  viewer.update(1 / 60);
  check(decodes === 1 && applies === 1 && viewer.stats.snapshots === 2, 'six fresh snapshots did not become one decode/apply');
  check((viewer as any).latestAt === 1056, 'frame reconciliation changed arrival timestamp');
  check(viewer.game!.tick > 9, 'packet arrival age was not used by prediction');
  counts();
  for (let i = 0; i < 6; i++) send(9);
  send(8);
  viewer.update(0);
  check(decodes === 0 && applies === 0, 'applied duplicate/stale snapshots decoded');
  console.log('PASS six fresh packets => one decode/apply; stale packets => zero; arrival-age prediction');

  // Preserve last inputs while predicting; correction offsets still hide small body errors.
  const car = viewer.game!.cars.get(0)!;
  car.lastInput = { ...car.lastInput, throttle: 1 };
  const before = viewer.game!.tick;
  now += 20;
  viewer.update(1 / 60);
  check(viewer.game!.tick > before && car.lastInput.throttle === 1, 'prediction did not repeat the last car input');
  const shownX = viewer.game!.curr.cars.get(0)!.px;
  source.ball.setTranslation({ x: 0, y: 5, z: 0 }, true);
  source.cars.get(0)!.body.setTranslation({ ...car.body.translation(), x: shownX + .2 }, true);
  send(viewer.game!.tick);
  viewer.update(0);
  check(viewer.carRenderStates()[0].offsetPos!.length() > 0, 'small correction lost smoothing');

  // A newer authority state must replace superseded physics without speculating collisions.
  // Existing forward prediction and correction replay still publish deduplicated effects.
  const game = viewer.game!;
  const step = game.step.bind(game);
  let steps = 0, victim = 0;
  game.step = (input, dt) => {
    step(input, dt); steps++;
    game.demosThisTick.push({ victim, attacker: 1, x: 1, y: 2, z: 3 });
    game.ballHitRelSpeed = 12;
    game.ballBounceDeltaV = 7;
  };
  const base = game.tick;
  counts();
  for (let t = base + 1; t <= base + 6; t++) send(t);
  viewer.update(0);
  check(decodes === 1 && applies === 1 && steps === 0, 'batching ran discarded physics before applying newer authority');
  check(viewer.events.demos.length === 0 && viewer.events.ballHitSpeed === 0, 'superseded inputs invented collision effects');
  now += 20;
  viewer.update(1 / 60);
  check(viewer.events.demos.length === 1 && viewer.events.ballHitSpeed === 12 && viewer.events.ballBounceSpeed === 7, 'forward prediction effects were lost or duplicated');
  viewer.update(0);
  check(viewer.events.demos.length === 0 && viewer.events.ballHitSpeed === 0, 'effects replayed on the next frame');
  now += 100;
  viewer.update(.1);
  victim = 1;
  counts();
  send(game.tick - 2);
  viewer.update(0);
  check(decodes === 1 && applies === 1 && viewer.events.demos.some(d => d.victim === 1), 'reconciliation resimulation demos were erased before draw');
  steps = 0;
  send(game.tick + 1000);
  viewer.update(0);
  check(steps === 0, 'newer authority ran discarded catch-up physics');
  game.step = step;
  console.log('PASS prediction, smoothing and replay effects without discarded physics or invented catch-up effects');

  const validTick = game.tick + 1;
  counts(); send(validTick);
  const bad = packet(validTick + 1000);
  link.onFast!(bad.slice(0, 13));
  link.onFast!(bad.slice(0, -1));
  new DataView(bad).setUint8(9 + countOffset, 2); // only one serialized car follows
  link.onFast!(bad);
  viewer.update(0);
  check(decodes === 1 && applies === 1 && game.tick === validTick, 'malformed newer packet evicted a usable correction');
  send(validTick + 1);
  const countedDecode = Game.decode;
  Game.decode = () => { throw new RangeError('injected decode failure'); };
  viewer.update(0);
  Game.decode = countedDecode;
  check(game.tick === validTick, 'failed decode changed authority state');
  counts(); send(validTick + 1); viewer.update(0);
  check(decodes === 1 && applies === 1 && game.tick === validTick + 1, 'decode failure poisoned later valid state');
  console.log('PASS malformed newest packets preserve pending state; deferred decode failure is contained');

  source.phase = 'goal'; source.goalPause = 2;
  source.score.blue = 1; source.lastGoal = 'blue'; source.lastGoalScorer = 0; source.lastGoalSpeed = 42;
  for (let t = game.tick + 1, end = t + 6; t < end; t++) send(t);
  viewer.update(0);
  check(game.score.blue === 1 && game.lastGoal === 'blue' && game.lastGoalSpeed === 42 && !game.ballVisible, 'score/goal metadata or visibility was lost');
  check(inputs === 0, 'spectator sent gameplay input');
  console.log('PASS score/goal/audio metadata and no gameplay inputs');

  send(game.tick + 1);
  link.onCtrl!({ t: 'end' });
  counts(); viewer.update(0);
  check(!viewer.ready && !(viewer as any).pending && decodes === 0, 'end retained pending snapshot');
  source.phase = 'play'; source.score.blue = 0;
  link.onCtrl!({ t: 'start', config: FREE_PLAY_CONFIG, epoch: 2 });
  send(99999, 1); send(1, 2);
  await flush();
  check(viewer.ready && viewer.game!.tick === 1 && started === 2 && decodes === 1, 'old high tick poisoned rematch startup');
  send(99999, 1); send(2, 2);
  counts(); viewer.update(0);
  check(decodes === 1 && viewer.game!.tick === 2, 'old epoch poisoned rematch pending tick');
  send(3, 2);
  link.onCtrl!({ t: 'start', config: FREE_PLAY_CONFIG, epoch: 3 });
  await flush();
  check(!viewer.ready && !(viewer as any).pending, 'rematch retained the prior pending state');
  counts(); send(1, 3);
  check(viewer.ready && started === 3 && decodes === 1 && applies === 1, 'first snapshot after creation waited for update');
  send(2, 3);
  link.onClose!();
  counts(); viewer.update(0); send(4, 3);
  check(!viewer.ready && !(viewer as any).pending && decodes === 0, 'close retained or decoded pending snapshot');
  console.log('PASS end/close cleanup and old-match rejection before buffering/decoding');
} finally {
  viewer.leave(); source.destroy();
  Game.create = create; Game.decode = decode; Game.prototype.applyState = apply;
  if (nowDescriptor) Object.defineProperty(performance, 'now', nowDescriptor);
  else delete (performance as unknown as { now?: unknown }).now;
}
console.log('Spectator batching regression complete');
