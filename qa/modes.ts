import { ARENAS } from '../src/arenas';
import { EMPTY_INPUT } from '../src/input/types';
import { ClientSession } from '../src/net/client';
import { HostSession } from '../src/net/host';
import { teamCount } from '../src/net/roster';
import { Game } from '../src/sim/game';
import { ARENA } from '../src/sim/rl';
import { ByteReader } from '../src/sim/state';

const check = (condition: unknown, description: string) => { if (!condition) throw new Error(description); };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
let checks = 0;
const pass = (description: string) => { checks++; console.log(`PASS ${description}`); };

for (const perTeam of [1, 2, 3, 4]) {
  const mode = `${perTeam}v${perTeam}`;
  const host = await HostSession.create(`${mode} Host`);
  const clients: ClientSession[] = [];
  let driving = false;
  const separate = () => {
    const cars = [...host.game!.cars.values()];
    return cars.every((a, i) => cars.slice(i + 1).every((b) => {
      const p = a.body.translation(), q = b.body.translation();
      return Math.hypot(p.x - q.x, p.z - q.z) > 2.5;
    }));
  };
  async function advance(frames: number) {
    for (let i = 0; i < frames; i++) {
      const input = (id: number) => driving ? { ...EMPTY_INPUT, throttle: 1, boost: true, steer: id % 2 ? .3 : -.3 } : EMPTY_INPUT;
      host.update(input(0), 1 / 60, false);
      clients.forEach((client) => client.update(input(client.localId), 1 / 60, false));
      await flush();
    }
  }
  const all = (predicate: (session: HostSession | ClientSession) => boolean) => [host, ...clients].every(predicate);
  const positions = () => new Map([...host.game!.cars].map(([id, car]) => [id, { ...car.body.translation() }]));
  const everyCarMoved = (before: ReturnType<typeof positions>) => [...host.game!.cars].every(([id, car]) => {
    const p = before.get(id)!, q = car.body.translation();
    return Math.hypot(q.x - p.x, q.z - p.z) > 2 && car.boost < 33.34;
  });
  try {
    for (let id = 1; id < perTeam * 2; id++) clients.push(await ClientSession.create(host.code, `${mode} Player ${id}`, .5, id % 3));
    await flush();
    check(all((s) => s.lobby!.players.length === perTeam * 2 && teamCount(s.lobby!.players, 'blue') === perTeam && teamCount(s.lobby!.players, 'orange') === perTeam), `${mode} balanced rosters`);
    pass(`${mode}: balanced ${perTeam}/${perTeam} lobby on all sessions`);
    const arena = perTeam - 1;
    host.setSettings({ arena }); await flush();
    check(all(s => s.lobby!.settings.arena === arena), `${mode} arena lobby sync`);
    pass(`${mode}: chosen arena reaches all lobbies`);
    await host.startMatch(); await advance(10);
    check(all(s => s.game!.config.arena === arena), `${mode} arena match sync`);
    host.setSettings({ arena: (arena + 1) % ARENAS.length });
    check(host.settings.arena === arena, `${mode} mid-match venue locked`);
    pass(`${mode}: match venue synchronizes and stays locked during play`);
    check(separate() && all((s) => s.game!.phase === 'countdown' && s.game!.cars.size === perTeam * 2), `${mode} kickoff`);
    pass(`${mode}: separate kickoff positions, countdown and complete car count`);
    const state = Game.decode(new ByteReader(host.game!.snapshotBytes()));
    check(state.cars.length === perTeam * 2 && all((s) => s.carRenderStates().length === perTeam * 2), `${mode} snapshots/rendering`);
    check(all((s) => s.carRenderStates().every((c) => c.body === c.id % 3)), `${mode} body metadata`);
    pass(`${mode}: binary snapshots and all render bodies`);
    await advance(180);
    check(all((s) => s.game!.phase === 'play' && Math.abs(s.game!.timeRemaining - host.game!.timeRemaining) < .1), `${mode} countdown/clock`);
    pass(`${mode}: countdown releases and match clocks agree`);
    const before = positions(); driving = true; await advance(90); driving = false;
    check(everyCarMoved(before), `${mode} driving/input/boost`);
    pass(`${mode}: all host/client inputs drive and spend boost`);
    host.resetMatch(); await advance(3);
    check(separate() && all((s) => s.game!.phase === 'countdown'), `${mode} reset`);
    pass(`${mode}: reset synchronization and separate spawns`);
    await advance(183);
    host.game!.ball.setTranslation({ x: 0, y: 1, z: ARENA.extentY + 3 }, true);
    await advance(3);
    check(all((s) => s.game!.score.blue === 1 && s.game!.phase === 'goal'), `${mode} goal`);
    await advance(125);
    check(separate() && all((s) => s.game!.phase === 'countdown'), `${mode} goal kickoff`);
    pass(`${mode}: goal and post-goal kickoff synchronize`);
    host.endMatch(); await flush();
    check(all((s) => !s.game && !s.lobby!.inMatch), `${mode} end`);
    pass(`${mode}: end match returns everyone to lobby`);
    const nextArena = (arena + 1) % ARENAS.length;
    host.setSettings({ arena: nextArena });
    await host.startMatch(); await advance(190);
    check(all(s => s.game!.config.arena === nextArena), `${mode} arena rematch sync`);
    pass(`${mode}: next match uses the newly selected arena`);
    const restarted = positions(); driving = true; await advance(60); driving = false;
    check(everyCarMoved(restarted), `${mode}: rematch inputs blocked by stale previous-match acknowledgements`);
    pass(`${mode}: immediate rematch accepts all players' inputs`);
  } finally { clients.forEach((client) => client.leave()); host.leave(); }
}

for (const scenario of ['solo', 'two-on-blue', 'three-versus-one']) {
  const host = await HostSession.create('Start Rules Host');
  const clients: ClientSession[] = [];
  try {
    const count = scenario === 'solo' ? 0 : scenario === 'two-on-blue' ? 1 : 3;
    for (let i = 0; i < count; i++) clients.push(await ClientSession.create(host.code, `Rule ${i}`, .5, 0));
    if (scenario === 'two-on-blue') clients[0].requestTeam('blue');
    if (scenario === 'three-versus-one') clients[0].requestTeam('blue');
    await flush();
    const expectedBlue = scenario === 'solo' ? 1 : scenario === 'two-on-blue' ? 2 : 3;
    const expectedOrange = scenario === 'three-versus-one' ? 1 : 0;
    check(teamCount(host.lobby.players, 'blue') === expectedBlue && teamCount(host.lobby.players, 'orange') === expectedOrange, `start-rule fixture ${scenario}`);
    await host.startMatch();
    check(host.lobby.inMatch && host.game!.cars.size === count + 1, `start rules ${scenario}`);
    pass(`start rules: ${scenario} is currently allowed (no minimum or equal-team requirement)`);
  } finally { clients.forEach((client) => client.leave()); host.leave(); }
}
console.log(`PASS ${checks} mode/start-rule checks; in-memory transport, no browser or real WebRTC coverage.`);
