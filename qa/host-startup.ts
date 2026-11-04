/** Fault-injected host startup checks; real HostSession with in-memory transport. */
import assert from 'node:assert/strict';
import { Game } from '../src/sim/game';
import { HostSession } from '../src/net/host';
import { PROTOCOL_VERSION, type CtrlMsg } from '../src/net/protocol';
import { joinRoom } from './mock-transport';

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function candidate(failure?: Error) {
  const state = { destroyed: 0, kickoffs: 0, cars: [] as number[] };
  const game = {
    setDodgeDeadzone() {},
    addCar(id: number) { state.cars.push(id); },
    removeCar() {},
    resetKickoff() { state.kickoffs++; if (failure) throw failure; },
    destroy() { state.destroyed++; },
  } as unknown as Game;
  return { game, state };
}
async function observe(host: HostSession, spectator: boolean) {
  const { link } = await joinRoom(host.code);
  const messages: CtrlMsg[] = [];
  link.onCtrl = msg => messages.push(msg);
  link.sendCtrl(spectator
    ? { t: 'spectate', version: PROTOCOL_VERSION }
    : { t: 'hello', version: PROTOCOL_VERSION, name: 'Player', body: 0, dodgeDeadzone: .5 });
  await flush();
  return { link, messages };
}
const starts = (messages: CtrlMsg[]) => messages.filter(m => m.t === 'start');
const originalCreate = Game.create;
const hosts: HostSession[] = [];
async function host() {
  const value = await HostSession.create('Host');
  hosts.push(value);
  return value;
}

try {
  const retryHost = await host();
  const player = await observe(retryHost, false);
  const viewer = await observe(retryHost, true);
  const failure = new Error('Physics initialization failed');
  Game.create = async () => { throw failure; };
  const before = structuredClone(retryHost.lobby);
  await assert.rejects(retryHost.startMatch(), error => error === failure);
  await flush();
  assert.deepEqual(retryHost.lobby, before, 'failed creation changed the lobby');
  assert.equal(retryHost.game, null);
  assert.equal(starts(player.messages).length + starts(viewer.messages).length, 0);
  const good = candidate();
  Game.create = async () => good.game;
  await retryHost.startMatch();
  await flush();
  assert.equal(retryHost.game, good.game);
  assert.equal(retryHost.lobby.inMatch, true);
  assert.deepEqual(good.state.cars, [0, 1]);
  assert.equal(good.state.kickoffs, 1);
  assert.equal(starts(player.messages).length, 1);
  assert.deepEqual(starts(viewer.messages).map(m => m.epoch), [1], 'failure consumed a spectator epoch');
  console.log('PASS creation failure propagates the original error; retry starts once with epoch 1');

  // A second failure after a completed match must also preserve the epoch sequence.
  retryHost.endMatch();
  Game.create = async () => { throw failure; };
  await assert.rejects(retryHost.startMatch(), error => error === failure);
  const rematch = candidate();
  Game.create = async () => rematch.game;
  await retryHost.startMatch();
  await flush();
  assert.deepEqual(starts(viewer.messages).map(m => m.epoch), [1, 2]);
  console.log('PASS failed rematch does not advance the spectator epoch');

  const concurrentHost = await host();
  const pending = deferred<Game>();
  let calls = 0, notifications = 0;
  Game.create = () => { calls++; return pending.promise; };
  concurrentHost.onMatchStarted = () => notifications++;
  const starting = concurrentHost.startMatch();
  await concurrentHost.startMatch();
  assert.equal(calls, 1, 'concurrent Start created a second game');
  const concurrentGame = candidate();
  pending.resolve(concurrentGame.game);
  await starting;
  await concurrentHost.startMatch();
  assert.equal(calls, 1, 'Start during an active match created another game');
  assert.equal(notifications, 1);
  assert.equal(concurrentGame.state.destroyed, 0);
  console.log('PASS concurrent and active-match Start requests cannot duplicate startup');

  const leavingHost = await host();
  const leavingViewer = await observe(leavingHost, true);
  const leavingPending = deferred<Game>();
  let leavingCalls = 0, leavingNotifications = 0;
  Game.create = () => { leavingCalls++; return leavingPending.promise; };
  leavingHost.onMatchStarted = () => leavingNotifications++;
  const leavingStart = leavingHost.startMatch();
  leavingHost.leave();
  const abandoned = candidate();
  leavingPending.resolve(abandoned.game);
  await leavingStart;
  await leavingHost.startMatch();
  await flush();
  assert.equal(abandoned.state.destroyed, 1);
  assert.equal(abandoned.state.kickoffs, 0);
  assert.equal(leavingHost.game, null);
  assert.equal(leavingHost.lobby.inMatch, false);
  assert.equal(leavingNotifications, 0);
  assert.equal(starts(leavingViewer.messages).length, 0);
  assert.equal(leavingCalls, 1, 'ended session allowed another creation');
  console.log('PASS leaving during creation destroys the candidate and cannot resurrect the room');

  const setupHost = await host();
  const setupViewer = await observe(setupHost, true);
  const old = candidate();
  setupHost.game = old.game;
  const setupFailure = new Error('Kickoff setup failed');
  const partial = candidate(setupFailure);
  Game.create = async () => partial.game;
  const oldLobby = structuredClone(setupHost.lobby);
  await assert.rejects(setupHost.startMatch(), error => error === setupFailure);
  await flush();
  assert.equal(partial.state.destroyed, 1);
  assert.equal(old.state.destroyed, 0, 'failed setup destroyed the previous game');
  assert.equal(setupHost.game, old.game);
  assert.deepEqual(setupHost.lobby, oldLobby);
  assert.equal(starts(setupViewer.messages).length, 0);
  const replacement = candidate();
  Game.create = async () => replacement.game;
  await setupHost.startMatch();
  await flush();
  assert.equal(old.state.destroyed, 1);
  assert.equal(replacement.state.destroyed, 0, 'committed game was cleaned up as a candidate');
  assert.equal(setupHost.game, replacement.game);
  assert.deepEqual(starts(setupViewer.messages).map(m => m.epoch), [1]);
  console.log('PASS setup failure cleans only the partial candidate, preserves old state and permits retry');
} finally {
  Game.create = originalCreate;
  for (const value of hosts) value.leave();
}
console.log('Host startup regression complete');
