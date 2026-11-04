import { EMPTY_INPUT } from '../src/input/types';
import { ClientSession } from '../src/net/client';
import { HostSession } from '../src/net/host';
import { MAX_SPECTATORS, Packet, encodeSnapshot, type CtrlMsg } from '../src/net/protocol';
import { SpectatorSession } from '../src/net/spectator';
import { joinRoom } from './mock-transport';

const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const nowDescriptor = Object.getOwnPropertyDescriptor(performance, 'now');
let frameNo = 0;
Object.defineProperty(performance, 'now', { configurable: true, value: () => 10000 + frameNo * 1000 / 60 });

interface TestLink { sendFast: (buf: ArrayBuffer) => void; other: TestLink }
const linkOf = (s: SpectatorSession) => (s as unknown as { link: TestLink }).link;

/** Displayed position of a car on the spectator (interpolated tick + fading correction). */
function shown(s: SpectatorSession, id: number) {
  const st = s.carRenderStates().find(c => c.id === id)!;
  const a = st.alpha;
  return {
    x: st.prev.px + (st.curr.px - st.prev.px) * a + (st.offsetPos?.x ?? 0),
    z: st.prev.pz + (st.curr.pz - st.prev.pz) * a + (st.offsetPos?.z ?? 0),
  };
}

const host = await HostSession.create('Spectated host');
const client = await ClientSession.create(host.code, 'Player two', .5, 1);
const viewer = await SpectatorSession.create(host.code);
let viewerInputs = 0;
const viewerSend = linkOf(viewer).sendFast.bind(linkOf(viewer));
linkOf(viewer).sendFast = (buf) => { if (new Uint8Array(buf)[0] === Packet.Input) viewerInputs++; viewerSend(buf); };
let started = 0;
viewer.onMatchStarted = () => started++;
const extra: SpectatorSession[] = [];
async function advance(frames: number, throttle = 0, steer = 0, onFrame?: () => void) {
  for (let i = 0; i < frames; i++) {
    frameNo++;
    host.update({ ...EMPTY_INPUT, throttle, steer }, 1 / 60, false);
    client.update({ ...EMPTY_INPUT, throttle, steer: -steer, boost: throttle > 0 }, 1 / 60, false);
    viewer.update(1 / 60);
    for (const s of extra) s.update(1 / 60);
    await flush();
    onFrame?.();
  }
}
try {
  await flush();
  check(host.lobby.players.length === 2 && host.lobby.spectators === 1, 'spectator took a player slot or was not counted');
  check(client.lobby.spectators === 1 && viewer.players.length === 2, 'watcher count or roster did not reach room members');
  console.log('PASS spectator joins without a slot; host and players see 1 watching');

  await host.startMatch();
  await advance(30);
  check(viewer.ready && started === 1 && viewer.game!.cars.size === 2, 'spectator did not synchronize both cars at match start');
  console.log('PASS spectator synchronizes at match start');

  await advance(200); // through the kickoff countdown
  check(viewer.game!.phase === 'play', 'spectator never left the kickoff countdown');
  let maxLag = 0, maxError = 0, snapshotsBefore = viewer.stats.snapshots;
  await advance(300, 1, .35, () => {
    maxLag = Math.max(maxLag, Math.abs(host.game!.tick - viewer.game!.tick));
    for (const id of [0, client.localId]) {
      const truth = host.game!.curr.cars.get(id)!;
      const p = shown(viewer, id);
      maxError = Math.max(maxError, Math.hypot(p.x - truth.px, p.z - truth.pz));
    }
  });
  const perFrame = (viewer.stats.snapshots - snapshotsBefore) / 300;
  console.log(`Spectator live diagnostic: maxTickLag=${maxLag}, maxPositionError=${maxError.toFixed(3)}m, snapshotsPerFrame=${perFrame.toFixed(2)}, resims=${viewer.stats.resims}, clockSnaps=${viewer.stats.clockSnaps}`);
  check(perFrame > .95, 'host did not send the newest tick to spectators every frame');
  check(maxLag <= 2, 'spectator picture fell more than two ticks behind the host');
  check(maxError < .6, 'spectator extrapolation drifted visibly from the authority');
  check(viewerInputs === 0, 'spectator sent gameplay inputs');
  console.log('PASS driving: spectator stays within two ticks and 0.6 m of the host, sends no inputs');

  // Late arrival mid-match and capacity.
  for (let i = 1; i < MAX_SPECTATORS; i++) extra.push(await SpectatorSession.create(host.code));
  await advance(6, 1);
  check(host.lobby.spectators === MAX_SPECTATORS && extra.every(s => s.ready), 'late spectators did not synchronize mid-match');
  let rejected = '';
  try { await SpectatorSession.create(host.code); } catch (err) { rejected = String(err); }
  check(rejected.includes('maximum'), 'spectator beyond capacity was not rejected');
  console.log(`PASS ${MAX_SPECTATORS - 1} late spectators synchronize mid-match; spectator ${MAX_SPECTATORS + 1} rejected`);

  const { link } = await joinRoom(host.code);
  const replies: CtrlMsg[] = [];
  link.onCtrl = (msg) => replies.push(msg);
  link.sendCtrl({ t: 'spectate', version: 999 });
  await flush();
  check(replies.some(m => m.t === 'reject' && m.reason.includes('Version')), 'old spectator protocol version was not rejected');
  console.log('PASS mismatched spectator version rejected');

  for (const s of extra.splice(0)) s.leave();
  await flush();
  check(host.lobby.spectators === 1 && client.lobby.spectators === 1, 'leaving spectators were not removed from the count');

  const oldSnapshot = encodeSnapshot(host.game!.snapshotBytes(), 1, 0);
  host.endMatch(); await flush();
  linkOf(viewer).other.sendFast(oldSnapshot);
  await flush();
  check(!viewer.game, 'old snapshot revived an ended match');
  check(!viewer.game && !viewer.inMatch, 'spectator kept a game after the host ended the match');
  // Deliver an old high-tick packet across the reliable start / asynchronous game creation.
  await host.startMatch();
  linkOf(viewer).other.sendFast(oldSnapshot);
  await advance(10);
  check(viewer.game!.tick < 30, 'old-match packet poisoned the new match clock');
  const freshTick = viewer.game!.tick;
  const snapshotCount = viewer.stats.snapshots;
  linkOf(viewer).other.sendFast(oldSnapshot);
  // A truncated pong must not abort the packet callback either.
  linkOf(viewer).other.sendFast(new Uint8Array([Packet.Pong]).buffer);
  await flush();
  check(viewer.game!.tick === freshTick && viewer.stats.snapshots === snapshotCount, 'stale match packet was applied after new synchronization');
  await advance(5);
  check(viewer.game!.tick > freshTick, 'new snapshots stopped after a stale match packet');
  console.log('PASS old-match packets rejected across end/start and after new synchronization; truncated pong ignored');
  check(viewer.ready && started === 2, 'spectator did not follow a rematch');
  console.log('PASS leave count, match end and rematch follow the host');

  let ended = '';
  viewer.onEnded = (reason) => { ended = reason; };
  host.leave(); await flush();
  check(ended.length > 0, 'spectator was not told the host left');
  console.log('PASS host departure ends the spectator session');
} finally {
  client.leave(); viewer.leave(); host.leave();
  for (const s of extra) s.leave();
}

// Delayed, jittered and lossy fast channel: the picture must stay near live without runaway.
const lossyHost = await HostSession.create('Lossy host');
const lossyViewer = await SpectatorSession.create(lossyHost.code);
const queue: { due: number; deliver: () => void }[] = [];
for (const [direction, link] of [linkOf(lossyViewer), linkOf(lossyViewer).other].entries()) {
  const send = link.sendFast.bind(link);
  let packets = 0;
  link.sendFast = (buf) => {
    packets++;
    if (packets % 7 === 0) return;
    const copy = buf.slice(0);
    queue.push({ due: frameNo + 1 + ((packets + direction) % 3), deliver: () => send(copy) });
  };
}
try {
  await lossyHost.startMatch(); await flush();
  let maxLag = 0;
  for (let i = 0; i < 520; i++) {
    frameNo++;
    lossyHost.update({ ...EMPTY_INPUT, throttle: i > 230 ? 1 : 0, steer: .3, boost: i > 300 }, 1 / 60, false);
    lossyViewer.update(1 / 60);
    const due = queue.filter(p => p.due <= frameNo);
    for (let j = queue.length - 1; j >= 0; j--) if (queue[j].due <= frameNo) queue.splice(j, 1);
    due.forEach(p => p.deliver());
    await Promise.resolve(); await Promise.resolve();
    if (i > 240 && lossyViewer.ready) maxLag = Math.max(maxLag, Math.abs(lossyHost.game!.tick - lossyViewer.game!.tick));
  }
  const truth = lossyHost.game!.curr.cars.get(0)!;
  const p = shown(lossyViewer, 0);
  const error = Math.hypot(p.x - truth.px, p.z - truth.pz);
  console.log(`Lossy spectator diagnostic: ping=${lossyViewer.ping}ms, maxTickLag=${maxLag}, finalError=${error.toFixed(3)}m, clockSnaps=${lossyViewer.stats.clockSnaps}`);
  check(lossyViewer.ready && maxLag <= 6, 'lossy spectator fell behind the host');
  check(error < 1, 'lossy spectator drifted from the authority');
  check(lossyViewer.stats.clockSnaps < 4, 'lossy spectator clock repeatedly jumped');
  console.log('PASS delayed/jittered/lossy spectator stays near live');
} finally {
  lossyViewer.leave(); lossyHost.leave();
  if (nowDescriptor) Object.defineProperty(performance, 'now', nowDescriptor);
  else delete (performance as unknown as { now?: unknown }).now;
}
console.log('Spectator regression complete');
