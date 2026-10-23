import { EMPTY_INPUT, type CarInput } from '../src/input/types';
import { ClientSession } from '../src/net/client';
import { HostSession } from '../src/net/host';
import { MAX_PLAYERS, type LobbyPlayer } from '../src/net/protocol';
import { balancedTeam, teamCount, teamHasSpace } from '../src/net/roster';
import { loadIceConfig } from '../src/net/transport';
import { FREE_PLAY_CONFIG, Game } from '../src/sim/game';
import { TICK_DT } from '../src/sim/rl';
import { ByteReader, quantizeInput } from '../src/sim/state';

const runButton = document.querySelector<HTMLButtonElement>('#run')!;
const status = document.querySelector<HTMLDivElement>('#status')!;
const results = document.querySelector<HTMLOListElement>('#results')!;
const roster = document.querySelector<HTMLTableSectionElement>('#roster')!;

function check(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function pass(message: string): void {
  const row = document.createElement('li');
  row.className = 'pass'; row.textContent = `PASS · ${message}`;
  results.appendChild(row);
}

async function until(predicate: () => boolean, message: string, timeout = 12000): Promise<void> {
  const end = performance.now() + timeout;
  while (!predicate()) {
    if (performance.now() >= end) throw new Error(`Timed out: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

function separate(game: Game): boolean {
  const cars = [...game.cars.values()];
  return cars.every((a, i) => cars.slice(i + 1).every((b) => {
    const p = a.body.translation(), q = b.body.translation();
    return Math.hypot(p.x - q.x, p.z - q.z) > 2.5;
  }));
}

async function verifySimulation(): Promise<void> {
  const game = await Game.create({ ...FREE_PLAY_CONFIG, infiniteBoost: false, countdown: 3, matchSeconds: 300, seed: 41 });
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
    pass('Eight arrivals balance to 4 blue / 4 orange; occupied teams reject extra places');
    for (let kickoff = 0; kickoff < 10; kickoff++) {
      game.resetKickoff();
      check(separate(game), 'eight unique kickoff positions');
    }
    pass('Ten kickoffs place all eight cars separately on their own sides');
    restored.restore(new ByteReader(game.snapshotBytes()));
    const decoded = Game.decode(new ByteReader(game.snapshotBytes()));
    check(decoded.cars.length === 8 && restored.cars.size === 8, 'eight-car binary snapshot round trip');
    for (const car of decoded.cars) {
      const actual = restored.cars.get(car.id)!;
      check(actual.team === car.team && actual.boost === car.state.boost, 'snapshot team/boost');
    }
    pass(`Eight-car snapshot round trip preserves slots, teams and boost (${game.snapshotBytes().byteLength} bytes)`);

    // Removing a non-final slot used to place the replacement on the last teammate's car.
    game.removeCar(2); game.addCar(2, 'blue');
    check(separate(game), 'replacement spawned on a teammate');
    pass('Replacing a non-final slot selects an unoccupied kickoff position');
    const victim = game.cars.get(2)!;
    victim.setDemoed(true); victim.demoTimer = TICK_DT / 2;
    for (let i = 0; i < 362; i++) game.step(EMPTY_INPUT, TICK_DT);
    check(!victim.demoed && separate(game), 'demolition respawn overlapped another car');
    pass('Demolition respawn with eight cars keeps the returning car separate');

    game.resetKickoff();
    for (let i = 0; i < 362; i++) game.step(EMPTY_INPUT, TICK_DT);
    const before = new Map([...game.cars].map(([id, car]) => [id, { ...car.body.translation() }]));
    const inputs = new Map<number, CarInput>();
    for (const id of game.cars.keys()) inputs.set(id, quantizeInput({ ...EMPTY_INPUT, throttle: 1, boost: true, steer: id % 2 ? .2 : -.2 }));
    for (let i = 0; i < 120; i++) game.step(inputs, TICK_DT);
    check([...game.cars].every(([id, car]) => {
      const p = before.get(id)!, q = car.body.translation();
      return Math.hypot(q.x - p.x, q.z - p.z) > 2 && car.boost < 33.34;
    }), 'held throttle/boost did not drive every car');
    pass('Sustained throttle, steering and boost move all eight cars and spend boost');
  } finally { game.destroy(); restored.destroy(); }
}

runButton.addEventListener('click', async () => {
  runButton.disabled = true; results.replaceChildren(); roster.replaceChildren();
  let host: HostSession | null = null;
  const clients: ClientSession[] = [];
  let frame = 0;
  let driving = false;
  try {
    status.textContent = 'Checking team limits, kickoff, snapshots and driving…';
    await verifySimulation();
    await loadIceConfig();
    status.textContent = 'Creating a real room and connecting seven clients…';
    host = await HostSession.create('QA Host');
    host.hostBody = 0;
    let previous = performance.now(), nextRoster = 0;
    const renderRoster = () => {
      const players = host!.lobby.players;
      roster.replaceChildren(...players.map((player) => {
        const client = clients.find((c) => c.localId === player.slot);
        const values = [player.slot, player.name, player.team, ['Scout', 'Arrow', 'Bruiser'][player.body],
          (client ?? host!)?.carRenderStates().length ?? 0, client?.stats.snapshots ?? 'authority', client?.ping === null ? '—' : `${client?.ping ?? '—'} ms`];
        const row = document.createElement('tr'); row.className = player.team;
        row.append(...values.map((value) => { const cell = document.createElement('td'); cell.textContent = String(value); return cell; }));
        return row;
      }));
    };
    const pump = (now: number) => {
      const dt = Math.min(.05, (now - previous) / 1000); previous = now;
      const inputFor = (id: number): CarInput => driving ? { ...EMPTY_INPUT, throttle: 1, boost: true, steer: id % 2 ? .3 : -.3 } : EMPTY_INPUT;
      host!.update(inputFor(0), dt, false);
      for (const client of clients) client.update(inputFor(client.localId), dt, false);
      if (now > nextRoster) { renderRoster(); nextRoster = now + 500; }
      frame = requestAnimationFrame(pump);
    };
    frame = requestAnimationFrame(pump);
    for (let i = 1; i < MAX_PLAYERS; i++) clients.push(await ClientSession.create(host.code, `QA Player ${i}`, .5 + i * .02, i % 3));
    await until(() => clients.every((c) => c.lobby.players.length === 8), 'all eight lobby rosters');
    check(teamCount(host.lobby.players, 'blue') === 4 && teamCount(host.lobby.players, 'orange') === 4, 'network roster 4v4');
    pass(`Real WebRTC room ${host.code}: one host + seven clients, all eight rosters agree on 4v4`);

    let rejected = '';
    try {
      const ninth = await ClientSession.create(host.code, 'QA Ninth', .5, 0);
      ninth.leave();
    } catch (err) { rejected = String(err); }
    check(rejected.includes('Room is full'), 'ninth player was not rejected');
    pass('A ninth real connection receives “Room is full (8/8 players)”');
    check(!host.setHostTeam('orange') && host.hostTeam === 'blue', 'host exceeded orange team capacity');
    const orange = clients.find((c) => c.lobby.players.find((p) => p.slot === c.localId)?.team === 'orange')!;
    orange.requestTeam('blue');
    await until(() => orange.lobby.status.includes('team is full'), 'client full-team rejection');
    check(teamCount(host.lobby.players, 'blue') === 4 && teamCount(host.lobby.players, 'orange') === 4, 'blocked team request changed roster');
    pass('Both host and client are blocked from switching into a full team');

    await host.startMatch();
    await until(() => clients.every((c) => c.game?.cars.size === 8 && c.carRenderStates().length === 8 && c.stats.snapshots > 10), 'eight complete client snapshots');
    check(separate(host.game!), 'online kickoff overlap');
    pass('Match start synchronizes all eight cars and render bodies on every client');
    await until(() => host!.game?.phase === 'play', 'three-second kickoff countdown');
    check(clients.every((c) => c.game!.timeRemaining <= 300 && c.game!.timeRemaining > 285), 'match clock synchronization');
    pass('Countdown releases eight cars; every client receives the live match clock');

    const before = new Map([...host.game!.cars].map(([id, car]) => [id, { ...car.body.translation() }]));
    const startTick = host.game!.tick;
    driving = true;
    await until(() => host!.game!.tick >= startTick + 180, 'sustained network driving');
    driving = false;
    check([...host.game!.cars].every(([id, car]) => {
      const p = before.get(id)!, q = car.body.translation();
      return Math.hypot(q.x - p.x, q.z - p.z) > 2 && car.boost < 33.34;
    }), 'remote input did not drive all eight authoritative cars');
    pass('All seven client input streams plus host input drive and boost their authoritative cars');

    const changed = clients.find((c) => c.localId === 2)!;
    changed.setBody(2);
    await until(() => clients.every((c) => c.carRenderStates().find((p) => p.id === 2)?.body === 2), 'body synchronization to seven clients');
    check(host.carRenderStates().find((p) => p.id === 2)?.body === 2, 'host body sync');
    pass('A mid-match Bruiser selection reaches all eight render states without changing handling');

    const leaving = clients.find((c) => c.localId === 7)!;
    const leavingSlot = leaving.localId;
    clients.splice(clients.indexOf(leaving), 1); leaving.leave();
    await until(() => host!.lobby.players.length === 7 && host!.game!.cars.size === 7 && clients.every((c) => c.carRenderStates().length === 7), 'disconnect removal from every snapshot');
    pass('A client disconnect removes its car and frees its team place on all remaining peers');
    changed.requestTeam('orange');
    await until(() => host!.lobby.players.find((p) => p.slot === 2)?.team === 'orange' && clients.every((c) => c.carRenderStates().find((p) => p.id === 2)?.team === 'orange'), 'valid mid-match team switch');
    pass('An allowed mid-match team switch updates authoritative and interpolated team colors');
    const rejoined = await ClientSession.create(host.code, 'QA Rejoined', .65, 1);
    clients.push(rejoined);
    await until(() => clients.every((c) => c.game?.cars.size === 8 && c.carRenderStates().length === 8 && c.lobby.players.length === 8), 'mid-match replacement synchronization');
    check(rejoined.localId === leavingSlot && teamCount(host.lobby.players, 'blue') === 4 && teamCount(host.lobby.players, 'orange') === 4, 'reused slot / balance');
    check(host.game!.cars.get(leavingSlot)!.dodgeDeadzone === .65 && host.carRenderStates().find((p) => p.id === leavingSlot)?.body === 1, 'replacement settings leaked from former occupant');
    pass('Mid-match rejoin reuses the vacant slot, restores 4v4 and applies the new body/deadzone');
    host.resetMatch();
    await until(() => clients.every((c) => c.game?.phase === 'countdown'), 'eight-player match reset');
    check(separate(host.game!), 'reset kickoff overlap');
    pass('Reset creates eight separate kickoff positions and synchronizes the countdown');
    renderRoster();

    host.endMatch();
    await until(() => clients.every((c) => !c.game && !c.lobby.inMatch), 'return all clients to lobby');
    pass('End match returns all seven clients to the lobby while keeping the room');
    for (const client of clients.splice(1)) client.leave();
    await until(() => host!.lobby.players.length === 2, 'two-player lobby after departures');
    await host.startMatch();
    await until(() => clients[0].game?.cars.size === 2 && clients[0].carRenderStates().length === 2, 'smaller match');
    pass('Smaller host + one-client match still starts and synchronizes');
    let closed = false;
    clients[0].onEnded = (reason) => { closed = reason.includes('Disconnected from the host'); };
    host.leave();
    await until(() => closed, 'host leave disconnects client');
    pass('Host leave closes the room and notifies the remaining client');
    status.textContent = `PASS · ${results.children.length} checks · same-browser real WebRTC · connections closed`;
    status.className = 'pass';
  } catch (err) {
    status.textContent = `FAIL · ${String(err)}`; status.className = 'fail';
    const row = document.createElement('li'); row.className = 'fail'; row.textContent = String(err); results.appendChild(row);
  } finally {
    cancelAnimationFrame(frame);
    for (const client of clients) client.leave();
    host?.leave();
    runButton.disabled = false;
  }
});
