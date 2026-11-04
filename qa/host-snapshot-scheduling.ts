import { EMPTY_INPUT } from '../src/input/types';
import { Game } from '../src/sim/game';
import { ByteReader } from '../src/sim/state';
import { HostSession } from '../src/net/host';
import { Packet, PROTOCOL_VERSION } from '../src/net/protocol';
import { joinRoom } from './mock-transport';

const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
type TestLink = { sendFast(buf: ArrayBuffer): void; sendCtrl(msg: unknown): void; other: TestLink };
type Internals = { clients: Map<number, { link: TestLink; lastInputTick: number }>; spectators: Set<TestLink>; spectatorEpoch: number };
const internals = (host: HostSession) => host as unknown as Internals;
const snapshotTick = (buf: ArrayBuffer) => Game.decode(new ByteReader(buf.slice(9))).tick;

const host = await HostSession.create('Scheduling test');
const player = await joinRoom(host.code);
const viewer = await joinRoom(host.code);
const playerPackets: ArrayBuffer[] = [];
const viewerPackets: ArrayBuffer[] = [];
const hp = player.link.other.sendFast.bind(player.link.other);
const hv = viewer.link.other.sendFast.bind(viewer.link.other);
player.link.other.sendFast = b => { if (new Uint8Array(b)[0] === Packet.Snapshot) playerPackets.push(b.slice(0)); hp(b); };
viewer.link.other.sendFast = b => { if (new Uint8Array(b)[0] === Packet.Snapshot) viewerPackets.push(b.slice(0)); hv(b); };
try {
  player.link.sendCtrl({ t: 'hello', name: 'Player', version: PROTOCOL_VERSION, dodgeDeadzone: .5, body: 0 } as never);
  viewer.link.sendCtrl({ t: 'spectate', version: PROTOCOL_VERSION } as never);
  await flush();
  await host.startMatch();
  await flush();
  const state = internals(host);
  const client = state.clients.values().next().value!;
  client.lastInputTick = 137;
  const game = host.game!;
  const original = game.snapshotBytes.bind(game);
  let serializations = 0;
  game.snapshotBytes = () => { serializations++; return original(); };

  for (const hz of [60, 30, 20, 10]) {
    playerPackets.length = 0; viewerPackets.length = 0; serializations = 0;
    const updates = hz === 60 ? 12 : hz === 30 ? 6 : hz === 20 ? 4 : 2;
    const dt = 1 / hz;
    let expectedPlayer = 0;
    for (let i = 0; i < updates; i++) {
      const before = game.tick;
      const packetsBefore = playerPackets.length;
      host.update(EMPTY_INPUT, dt, false);
      const advanced = game.tick - before;
      if (advanced > 0 && game.tick % 2 === 0) expectedPlayer++;
      const got = playerPackets.at(-1);
      if (playerPackets.length > packetsBefore) {
        check(snapshotTick(got) === game.tick, `${hz}Hz update sent stale player tick ${snapshotTick(got)} instead of ${game.tick}`);
      }
      if (playerPackets.length) check(new DataView(playerPackets.at(-1)!).getInt32(1, true) === 137, 'player ack header was overwritten');
      if (viewerPackets.length) check(new DataView(viewerPackets.at(-1)!).getInt32(1, true) === state.spectatorEpoch, 'spectator epoch header was overwritten');
    }
    check(playerPackets.length === expectedPlayer, `${hz}Hz updates emitted ${playerPackets.length} player packets, expected ${expectedPlayer}`);
  }

  playerPackets.length = 0; viewerPackets.length = 0; serializations = 0;
  host.update(EMPTY_INPUT, 0, false);
  check(playerPackets.length === 0 && viewerPackets.length === 0 && serializations === 0, 'sent or serialized without a simulation step');

  playerPackets.length = 0; viewerPackets.length = 0; serializations = 0;
  (host as unknown as { accumulator: number }).accumulator = 0;
  const cadenceStartTick = game.tick;
  for (let i = 0; i < 120; i++) host.update(EMPTY_INPUT, 1 / 120, false);
  check(playerPackets.length === 60, `player cadence was ${playerPackets.length}/120, expected 60`);
  check(viewerPackets.length === 120, `spectator cadence was ${viewerPackets.length}/120, expected 120`);
  check(viewerPackets.every((packet, i) => snapshotTick(packet) === cadenceStartTick + i + 1), 'spectator did not receive the newest tick each host update');
  check(playerPackets.every(packet => new DataView(packet).getInt32(1, true) === 137), 'player packets did not retain per-player ack tick');
  check(viewerPackets.every(packet => new DataView(packet).getInt32(1, true) === state.spectatorEpoch), 'viewer packets did not retain spectator epoch');
  check(serializations === 120, `serialized ${serializations} times for 120 snapshot-needed ticks`);
  console.log('PASS host snapshots send newest catch-up tick at 60/30/20/10 Hz; preserve player ack and spectator epoch; serialize once per needed tick');
} finally {
  host.leave();
}
