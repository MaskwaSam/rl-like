import { EMPTY_INPUT } from '../src/input/types';
import { ClientSession } from '../src/net/client';
import { HostSession } from '../src/net/host';
import { Packet } from '../src/net/protocol';
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

// A shrinking RTT must drain the old prediction lead without revisiting acknowledged ticks.
const contractionHost = await HostSession.create('Lead contraction host');
const contractionClient = await ClientSession.create(contractionHost.code, 'Lead contraction client', .5, 0);
const contractionClock = contractionClient as unknown as { rttSamples: number[]; link: { sendFast: (buf: ArrayBuffer) => void } };
let sentInputs = 0;
const contractionSend = contractionClock.link.sendFast.bind(contractionClock.link);
contractionClock.link.sendFast = (buf) => {
  if (new Uint8Array(buf)[0] === Packet.Input) sentInputs++;
  contractionSend(buf);
};
async function contractAdvance(frames: number, throttle = 0, monotonic = false) {
  for (let i = 0; i < frames; i++) {
    const previousTick = contractionClient.game?.tick ?? -1;
    contractionHost.update(EMPTY_INPUT, 1 / 60, false);
    contractionClient.update({ ...EMPTY_INPUT, throttle }, 1 / 60, false);
    await flush();
    if (monotonic) check(contractionClient.game!.tick >= previousTick, 'RTT contraction rewound client tick into acknowledged input history');
  }
}
try {
  await contractionHost.startMatch(); await contractAdvance(200);
  contractionClient.ping = 900;
  contractionClock.rttSamples.splice(0, contractionClock.rttSamples.length, 900);
  await contractAdvance(30);
  check(contractionClient.game!.tick - contractionHost.game!.tick > 80, 'high RTT fixture did not establish a large prediction lead');
  contractionClient.ping = 0;
  contractionClock.rttSamples.splice(0);
  const sentBefore = sentInputs;
  const resyncBefore = contractionClient.stats.resyncLead;
  await contractAdvance(12, 1, true);
  check(contractionClient.stats.resyncLead === resyncBefore, 'shrinking RTT hard-resynchronized the prediction backward');
  check(sentInputs >= sentBefore + 10, 'retained future acknowledgements suppressed new inputs after RTT contraction');
  // Previously accepted future neutral inputs remain queued at the host until their ticks arrive.
  // Verify eventual authoritative driving, after allowing that queue to drain.
  const before = { ...contractionHost.game!.cars.get(contractionClient.localId)!.body.translation() };
  await contractAdvance(160, 1, true);
  const after = contractionHost.game!.cars.get(contractionClient.localId)!.body.translation();
  check(Math.hypot(after.x - before.x, after.z - before.z) > 2, 'authority never reached newly queued throttle inputs after RTT contraction');
  console.log('PASS high-RTT to LAN contraction preserves monotonic ticks and input sending; queued throttle eventually drives authority');
} finally { contractionClient.leave(); contractionHost.leave(); }

// Advance a virtual clock with deterministic one-way delay, jitter and dropped packets.
// Control delivery stays ordered; gameplay uses the same lossy fast-link contract as production.
const nowDescriptor = Object.getOwnPropertyDescriptor(performance, 'now');
let networkFrame = 0;
Object.defineProperty(performance, 'now', { configurable: true, value: () => 10000 + networkFrame * 1000 / 60 });
const delayedHost = await HostSession.create('Delayed host');
const delayedClient = await ClientSession.create(delayedHost.code, 'Delayed client', .5, 0);
interface TestLink { sendFast: (buf: ArrayBuffer) => void; other: TestLink }
const clientLink = (delayedClient as unknown as { link: TestLink }).link;
const queue: { due: number; deliver: () => void }[] = [];
for (const [direction, link] of [clientLink, clientLink.other].entries()) {
  const send = link.sendFast.bind(link);
  let packets = 0;
  link.sendFast = (buf) => {
    packets++;
    if (packets % 5 === 0) return;
    const copy = buf.slice(0);
    queue.push({ due: networkFrame + 8 + ((packets + direction) % 3), deliver: () => send(copy) });
  };
}
const acceptedTick = () => [...(delayedHost as unknown as { clients: Map<number, { lastInputTick: number }> }).clients.values()][0].lastInputTick;
try {
  await delayedHost.startMatch(); await flush();
  const before = { ...delayedHost.game!.cars.get(delayedClient.localId)!.body.translation() };
  for (networkFrame = 1; networkFrame <= 420; networkFrame++) {
    delayedHost.update(EMPTY_INPUT, 1 / 60, false);
    delayedClient.update({ ...EMPTY_INPUT, throttle: networkFrame > 220 ? 1 : 0 }, 1 / 60, false);
    const due = queue.filter(packet => packet.due <= networkFrame);
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].due <= networkFrame) queue.splice(i, 1);
    due.forEach(packet => packet.deliver());
    await Promise.resolve(); await Promise.resolve();
    if (networkFrame === 120) check(acceptedTick() >= 0, 'delayed startup input starvation did not recover without an accepted acknowledgement');
  }
  const after = delayedHost.game!.cars.get(delayedClient.localId)!.body.translation();
  check(Math.hypot(after.x - before.x, after.z - before.z) > 2, 'delayed/lossy input stream did not drive authoritative car');
  check(acceptedTick() > delayedHost.game!.tick - 30, 'delayed input stream stopped making progress');
  check(delayedClient.stats.resyncLead < 5, 'delayed clock recovery repeatedly hard-resynchronized');
  console.log(`PASS delayed/lossy startup and authoritative driving: RTT ${delayedClient.ping}ms, ${delayedClient.stats.resyncLead} lead resyncs`);
} finally {
  delayedClient.leave(); delayedHost.leave();
  if (nowDescriptor) Object.defineProperty(performance, 'now', nowDescriptor);
  else delete (performance as unknown as { now?: unknown }).now;
}
