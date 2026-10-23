import { EMPTY_INPUT } from '../src/input/types';
import { ClientSession } from '../src/net/client';
import { HostSession } from '../src/net/host';
import { Game } from '../src/sim/game';
import { TICK_DT } from '../src/sim/rl';

const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const host = await HostSession.create('Regression host');
const client = await ClientSession.create(host.code, 'Regression client', .5, 0);
let callbacks = 0;
client.onMatchStarted = () => {
  check(client.carRenderStates().length === 2, 'start callback fired before initial synchronization');
  callbacks++;
};
async function advance(frames: number, throttle = 0) {
  for (let i = 0; i < frames; i++) {
    host.update(EMPTY_INPUT, 1 / 60, false);
    client.update({ ...EMPTY_INPUT, throttle }, 1 / 60, false);
    await flush();
  }
}
try {
  await host.startMatch();
  await advance(20);
  check(callbacks === 1, 'initial start callback missing or duplicated');
  const lead = client.game!.tick - host.game!.tick;
  check(lead > 0, 'fixture must predict ahead of authority');
  check(Math.abs(client.game!.countdown - (host.game!.countdown - lead * TICK_DT)) < .0001,
    'matching snapshots rewound the predicted countdown');
  check(client.stats.replays < client.stats.snapshots / 2, 'matching countdown snapshots unnecessarily replayed');
  console.log(`PASS historical metadata preserves ${lead}-tick countdown lead; ${client.stats.replays}/${client.stats.snapshots} snapshots replayed`);
  await advance(170);
  check(host.game!.phase === 'play' && client.game!.phase === 'play', 'stationary kickoff did not release');
  check(client.game!.cars.get(client.localId)!.body.isDynamic() && client.game!.ball.isDynamic(), 'kickoff left predicted car or ball frozen');
  // An authoritative pad change must reconcile once, then its rounded snapshot anchor must
  // count down without repeatedly disagreeing with subsequent rounded snapshots.
  host.game!.pads[0].cooldown = 10;
  const cooldownReplays = client.stats.replays;
  await advance(200);
  check(host.game!.pads[0].cooldown > 6 && client.game!.pads[0].cooldown > 6, 'active cooldown fixture expired early');
  check(client.stats.replays - cooldownReplays <= 2, 'quantized active cooldown caused sustained unnecessary replays');
  await advance(420);
  check(host.game!.pads[0].cooldown === 0 && client.game!.pads[0].cooldown === 0, 'pad cooldown did not settle at zero on both timelines');
  const expiredReplays = client.stats.replays;
  await advance(50);
  check(client.stats.replays === expiredReplays, 'expired pad cooldown continues forcing replay');
  console.log(`PASS active pad cooldown through expiry; ${client.stats.replays - cooldownReplays} replays across 670 frames and none after expiry`);
  const before = { ...client.game!.cars.get(client.localId)!.body.translation() };
  await advance(60, 1);
  const after = client.game!.cars.get(client.localId)!.body.translation();
  check(Math.hypot(after.x - before.x, after.z - before.z) > 2, 'local predicted car cannot drive after neutral kickoff');
  console.log('PASS stationary kickoff releases local car and ball; subsequent throttle drives predicted car');
  host.endMatch(); await flush();

  // The host creates normally, but hold the client's creation while snapshots continue arriving.
  const originalCreate = Game.create;
  let release: (() => void) | undefined;
  let deferred = false;
  Game.create = async function(config) {
    if (deferred) await new Promise<void>(resolve => { release = resolve; });
    const game = await originalCreate.call(Game, config);
    deferred = true;
    return game;
  };
  try {
    await host.startMatch(); await flush();
    check(!!release, 'client creation was not held');
    await advance(12);
    check(callbacks === 1, 'start callback fired while game creation pending');
    release!(); await flush(); await flush();
    check(callbacks === 2 && !!client.game && client.carRenderStates().length === 2, 'buffered snapshot did not synchronize before start callback');
    check(client.game!.tick >= host.game!.tick, 'client did not adopt newest buffered snapshot');
    console.log('PASS newest snapshot buffered through async creation; start callback sees synchronized render state');
    host.endMatch(); await flush();

    deferred = false;
    await host.startMatch(); await flush();
    host.endMatch(); await flush();
    release!(); await flush(); await flush();
    check(!client.game && callbacks === 2, 'ended match resurrected after async creation');
    console.log('PASS ending during client creation prevents stale game resurrection');
  } finally { Game.create = originalCreate; }
} finally { client.leave(); host.leave(); }
