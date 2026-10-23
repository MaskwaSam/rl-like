import { ARENAS } from '../src/arenas';
import { EMPTY_INPUT, type CarInput } from '../src/input/types';
import { ClientSession } from '../src/net/client';
import { HostSession } from '../src/net/host';
import { MAX_PLAYERS, type LobbyPlayer } from '../src/net/protocol';
import { balancedTeam, teamCount, teamHasSpace } from '../src/net/roster';
import { FREE_PLAY_CONFIG, Game } from '../src/sim/game';
import { ARENA, TICK_DT } from '../src/sim/rl';
import { ByteReader } from '../src/sim/state';

// Match the in-memory transport's zero transit time to the simulation clock. Wall-clock
// scheduling pauses must not inflate RTT while fixed simulation frames run independently.
const nowDescriptor = Object.getOwnPropertyDescriptor(performance, 'now');
let virtualNow = 0;
Object.defineProperty(performance, 'now', { configurable: true, value: () => virtualNow });
try {
let passed = 0;
function check(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}
function pass(message: string): void { passed++; console.log(`PASS ${message}`); }
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
function separate(game: Game): boolean {
  const cars = [...game.cars.values()];
  return cars.every((a, i) => cars.slice(i + 1).every((b) => {
    const p = a.body.translation(), q = b.body.translation();
    return Math.hypot(p.x - q.x, p.z - q.z) > 2.5;
  }));
}

const game = await Game.create({ ...FREE_PLAY_CONFIG, countdown: 3, matchSeconds: 300, infiniteBoost: false, seed: 41 });
const restored = await Game.create(game.config);
try {
  const players: LobbyPlayer[] = [];
  for (let id = 0; id < MAX_PLAYERS; id++) {
    const team = balancedTeam(players);
    players.push({ slot: id, name: `Test ${id}`, team, body: id % 3 });
    game.addCar(id, team);
  }
  check(teamCount(players, 'blue') === 4 && teamCount(players, 'orange') === 4, 'balanced arrivals');
  check(!teamHasSpace(players, 'orange', 0) && teamHasSpace(players, 'blue', 0), 'four-player team cap');
  pass('balanced eight-player admission and four-player team limits');
  for (let kickoff = 0; kickoff < 15; kickoff++) {
    game.resetKickoff(); check(separate(game), 'eight separate kickoff positions');
    check([...game.cars.values()].every((c) => c.body.translation().z * (c.team === 'blue' ? -1 : 1) > 0), 'team spawn on wrong side');
  }
  pass('15 eight-car kickoffs: unique positions and correct halves');
  restored.restore(new ByteReader(game.snapshotBytes()));
  const state = Game.decode(new ByteReader(game.snapshotBytes()));
  check(state.cars.length === 8 && restored.cars.size === 8, 'eight-car binary round trip');
  check(state.cars.every((c) => restored.cars.get(c.id)!.team === c.team && restored.cars.get(c.id)!.boost === c.state.boost), 'snapshot metadata');
  pass(`eight-car snapshot round trip (${game.snapshotBytes().byteLength} bytes), slots/teams/boost retained`);
  game.removeCar(2); game.addCar(2, 'blue'); check(separate(game), 'replacement overlaps teammate');
  pass('replacement of non-final slot chooses unoccupied spawn');
  for (let i = 0; i < 362; i++) game.step(EMPTY_INPUT, TICK_DT);
  const victim = game.cars.get(2)!;
  victim.setDemoed(true); victim.demoTimer = TICK_DT / 2;
  game.step(EMPTY_INPUT, TICK_DT);
  check(!victim.demoed && separate(game), 'demo respawn collision');
  pass('demolition respawn among eight cars avoids an occupied position');
  const before = new Map([...game.cars].map(([id, c]) => [id, { ...c.body.translation() }]));
  const inputs = new Map<number, CarInput>();
  for (const id of game.cars.keys()) inputs.set(id, { ...EMPTY_INPUT, throttle: 1, boost: true, steer: id % 2 ? .2 : -.2 });
  for (let i = 0; i < 120; i++) game.step(inputs, TICK_DT);
  check([...game.cars].every(([id, c]) => { const p = before.get(id)!, q = c.body.translation(); return Math.hypot(p.x - q.x, p.z - q.z) > 2 && c.boost < 33.34; }), 'held inputs did not drive each car');
  pass('120 ticks of sustained throttle, steering and boost drive all eight cars');
  game.ball.setTranslation({ x: 0, y: 1, z: ARENA.extentY + 3 }, true);
  game.step(EMPTY_INPUT, TICK_DT);
  check(game.score.blue === 1 && game.phase === 'goal', 'eight-car goal did not count');
  for (let i = 0; i < 250; i++) game.step(EMPTY_INPUT, TICK_DT);
  check(game.phase === 'countdown' && separate(game), 'goal kickoff');
  pass('goal scoring and post-goal eight-car kickoff');
} finally { game.destroy(); restored.destroy(); }

const host = await HostSession.create('Headless Host');
const clients: ClientSession[] = [];
let drive = false;
async function advance(frames: number): Promise<void> {
  for (let i = 0; i < frames; i++) {
    virtualNow += 1000 / 60;
    const input = (id: number): CarInput => drive ? { ...EMPTY_INPUT, throttle: 1, boost: true, steer: id % 2 ? .3 : -.3 } : EMPTY_INPUT;
    host.update(input(0), 1 / 60, false);
    for (const client of clients) client.update(input(client.localId), 1 / 60, false);
    await flush();
  }
}
try {
  for (let i = 1; i < 8; i++) clients.push(await ClientSession.create(host.code, `Client ${i}`, .5 + i * .02, i % 3));
  await flush();
  check(clients.every((c) => c.lobby.players.length === 8) && teamCount(host.lobby.players, 'blue') === 4, 'eight peers roster');
  pass('one host + seven session clients agree on eight-person 4v4 roster (in-memory transport)');
  let reason = '';
  try { const ninth = await ClientSession.create(host.code, 'Ninth', .5, 0); ninth.leave(); } catch (err) { reason = String(err); }
  check(reason.includes('Room is full'), 'ninth not rejected');
  pass('ninth session rejected as room full');
  check(!host.setHostTeam('orange'), 'host exceeded cap');
  clients[0].requestTeam('blue'); await flush();
  check(clients[0].lobby.status.includes('team is full') && teamCount(host.lobby.players, 'blue') === 4, 'client exceeded cap');
  pass('host/client full-team requests denied by authority');
  await host.startMatch(); await advance(190);
  check(host.game!.phase === 'play' && clients.every((c) => c.game?.cars.size === 8 && c.carRenderStates().length === 8 && c.stats.snapshots > 100), 'eight prediction snapshots');
  check(clients.every((c) => Math.abs(c.game!.timeRemaining - host.game!.timeRemaining) < .1), 'clock drift');
  pass('eight-client start/countdown, full state snapshots, interpolation and clock agreement');
  const before = new Map([...host.game!.cars].map(([id, c]) => [id, { ...c.body.translation() }]));
  drive = true; await advance(90); drive = false;
  check([...host.game!.cars].every(([id, c]) => { const p = before.get(id)!, q = c.body.translation(); return Math.hypot(p.x - q.x, p.z - q.z) > 2 && c.boost < 33.34; }), 'network inputs did not reach all cars');
  pass('all eight input streams move and boost their authoritative cars');
  const changed = clients[1]; changed.setBody(2); await advance(3);
  check([host, ...clients].every((s) => s.carRenderStates().find((c) => c.id === 2)?.body === 2), 'body update');
  pass('mid-match body selection synchronized to all eight peers');
  const leaving = clients.pop()!; leaving.leave(); await advance(3);
  check(host.game!.cars.size === 7 && clients.every((c) => c.carRenderStates().length === 7), 'disconnected car not removed');
  pass('disconnect frees one slot and removes the car from every peer');
  changed.requestTeam('orange'); await advance(3);
  check([host, ...clients].every((s) => s.carRenderStates().find((c) => c.id === 2)?.team === 'orange'), 'allowed switch not synchronized');
  pass('allowed mid-match team switch synchronized across authority and interpolated views');
  const rejoined = await ClientSession.create(host.code, 'Replacement', .65, 1); clients.push(rejoined); await advance(5);
  check(rejoined.localId === 7 && clients.every((c) => c.game?.cars.size === 8 && c.carRenderStates().length === 8), 'rejoin sync');
  check(teamCount(host.lobby.players, 'blue') === 4 && teamCount(host.lobby.players, 'orange') === 4 && host.game!.cars.get(7)!.dodgeDeadzone === .65 && host.carRenderStates().find((c) => c.id === 7)?.body === 1, 'replacement settings');
  pass('mid-match rejoin reuses slot, balances 4v4 and replaces body/deadzone');
  host.resetMatch(); await advance(3);
  check(separate(host.game!) && clients.every((c) => c.game!.phase === 'countdown'), 'eight-car reset');
  pass('reset synchronizes eight-car kickoff/countdown');
  host.endMatch(); await flush(); check(clients.every((c) => !c.game && !c.lobby.inMatch), 'end match');
  pass('end match returns all seven clients to lobby');
  for (const client of clients.splice(1)) client.leave(); await flush();
  await host.startMatch(); await advance(5);
  check(host.game!.cars.size === 2 && clients[0].carRenderStates().length === 2, 'smaller match start');
  pass('smaller two-player match still starts and synchronizes');
  let ended = ''; clients[0].onEnded = (message) => { ended = message; };
  host.leave(); check(ended.includes('Disconnected from the host'), 'host leave');
  pass('host leave notifies the remaining client and ends the room');
} finally { clients.forEach((c) => c.leave()); host.leave(); }
// Same seed and input history must produce identical simulation states in every visual venue.
const venues = await Promise.all(ARENAS.map(({ id: arena }) => Game.create({ ...FREE_PLAY_CONFIG, arena, seed: 41 })));
try {
  venues.forEach(g => g.addCar(0, 'blue'));
  for (let tick = 0; tick < 480; tick++) {
    const input = { ...EMPTY_INPUT, throttle: 1, steer: tick < 120 ? .3 : -.2, boost: true, jump: tick === 180, roll: tick > 180 && tick < 210 ? .5 : 0 };
    venues.forEach(g => g.step(input, TICK_DT));
  }
  const states = venues.map(g => new Uint8Array(g.snapshotBytes()));
  check(states.slice(1).every(state => state.length === states[0].length && state.every((byte, i) => byte === states[0][i])), 'arena appearance altered driving physics');
  pass('all four visual arenas produce byte-identical physics after 480 ticks of driving, boost, jump and roll');
} finally { venues.forEach(g => g.destroy()); }
console.log(`PASS ${passed} headless checks; in-memory transport is not a real WebRTC or cross-network test.`);
} finally {
  if (nowDescriptor) Object.defineProperty(performance, 'now', nowDescriptor);
  else delete (performance as unknown as { now?: unknown }).now;
}
