/** Real HTTP/WS -> room worker -> Rapier -> ServerRoomSession prediction integration.
 * No WebGL, browser, physical LAN or performance acceptance is implied.
 * Build prerequisites and invocation: qa/run-server-play.mjs.
 */
import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';
import { createServer } from 'node:net';
import { WebSocket as NodeSocket } from 'ws';
import type { RoomAdmission } from '../src/access';
import { ServerRoomSession } from '../src/net/server-session';
import { EMPTY_INPUT, type CarInput } from '../src/input/types';
import { Game, type GameState } from '../src/sim/game';
import { ByteReader } from '../src/sim/state';
import type { CtrlMsg } from '../src/net/protocol';

// Browser tabs own separate modules; this shared Node realm must finish initial WASM
// initialization before several real sessions create prediction worlds concurrently.
await RAPIER.init();
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
let checks = 0;
function check(value: unknown, description: string): asserts value {
  assert.ok(value, description); checks++; console.log(`PASS ${description}`);
}
async function wait(description: string, predicate: () => boolean, timeout = 12000) {
  const until = performance.now() + timeout;
  while (!predicate()) {
    if (driverError) throw driverError;
    if (performance.now() > until) throw new Error(`Timed out: ${description}`);
    await delay(15);
  }
}
// Reserve an OS-selected port, then release it immediately before starting the child.
const reservation = createServer();
await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
const address = reservation.address();
assert.ok(address && typeof address !== 'string');
const origin = `http://127.0.0.1:${address.port}`;
await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
const password = randomBytes(24).toString('base64url');
const salt = randomBytes(16);
const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(address.port), CAR_BIND: '127.0.0.1', CAR_ORIGIN: origin,
  CAR_PASSWORD_HASH: `${salt.toString('hex')}:${scryptSync(password, salt, 64).toString('hex')}`, CAR_ROOM_TTL_SECONDS: '300' };
delete env.CAR_PASSWORD_HASH_FILE;
const child = spawn(process.execPath, ['.server-build/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => { logs = (logs + chunk.toString()).slice(-6000); });
let childError: Error | undefined;
child.on('error', error => { childError = error; });

/** Same host-only cookie jar pattern as private-rooms, without importing its test side effects. */
class Browser {
  static readonly all: Browser[] = [];
  constructor() { Browser.all.push(this); }
  cookies = new Map<string, string>();
  sockets: BrowserSocket[] = [];
  header() { return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '); }
  async request<T>(path: string, body?: unknown): Promise<{ status: number; data: T }> {
    const response = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: this.header(), ...(body === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    for (const value of response.headers.getSetCookie()) {
      const [name, cookie] = value.split(';')[0].split('=');
      if (cookie) this.cookies.set(name, cookie); else this.cookies.delete(name);
    }
    return { status: response.status, data: await response.json() as T };
  }
}
const context = new AsyncLocalStorage<Browser>();
/** ws implements browser onopen/onmessage/binaryType; ALS also preserves the cookie jar
 * in SocketLink's reconnect timer. No transport, snapshot, input or prediction is mocked.
 * Observers decode copies only; all delivery still goes through production SocketLink.
 */
class BrowserSocket extends NodeSocket {
  controls: CtrlMsg[] = [];
  latest: GameState | null = null;
  epoch = 0;
  ack = -1;
  snapshots = 0;
  inputs = 0;
  pings = 0;
  pongs = 0;
  preAdmissionBinaries = 0;
  constructor(url: string) {
    const browser = context.getStore();
    assert.ok(browser, 'WebSocket constructed within its session cookie context');
    super(url, { headers: { Cookie: browser.header(), Origin: origin } });
    browser.sockets.push(this);
    this.on('error', () => {}); // production SocketLink handles browser error/close events
    this.on('message', (data, binary) => {
      if (!binary) {
        const message = JSON.parse(data.toString()) as CtrlMsg;
        this.controls.push(message);
        if (message.t === 'start') { this.epoch = message.epoch ?? 0; this.latest = null; this.ack = -1; }
        return;
      }
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as Buffer);
      const copy = bytes.slice();
      if (copy.byteLength < 5 || new DataView(copy.buffer).getUint32(0, true) !== this.epoch) return;
      if (copy[4] === 4) this.pongs++;
      if (copy[4] !== 2) return;
      const reader = new ByteReader(copy.slice(5).buffer);
      this.ack = reader.i32(); reader.u32();
      this.latest = Game.decode(reader); this.snapshots++;
    });
  }
  override emit(event: string | symbol, ...args: any[]): boolean {
    try { return super.emit(event, ...args); }
    catch (error) {
      if (event !== 'message') throw error;
      driverError = error; running = false; return false;
    }
  }
  override send(data: Parameters<NodeSocket['send']>[0], ...rest: any[]): void {
    if (data instanceof Uint8Array && data.byteLength >= 5) {
      if (!this.controls.some(message => message.t === 'welcome')) this.preAdmissionBinaries++;
      if (data[4] === 1) this.inputs++;
      if (data[4] === 3) this.pings++;
    }
    // Keep ws's overload implementation, including asynchronous send callbacks, intact.
    (NodeSocket.prototype.send as Function).call(this, data, ...rest);
  }
}
Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: BrowserSocket });
Object.defineProperty(globalThis, 'location', { configurable: true, value: new URL(origin) });

interface Player {
  browser: Browser; session: ServerRoomSession; rate: number; frames: number; starts: number;
  synchronizedGame: Game | null; updates: number; predictedSteps: number; paused: boolean; lastFrame: number; nextFrame: number;
}
const players: Player[] = [];
const ended: string[] = [];
let driver: ReturnType<typeof setTimeout> | undefined;
let driverError: unknown;
let running = false;
let driving = false;
let renderSamples = 0;
function finiteRender(player: Player) {
  const states = player.session.carRenderStates();
  assert.equal(states.length, players.length, 'render states include every human');
  for (const state of states) {
    for (const value of [...Object.values(state.prev), ...Object.values(state.curr), state.alpha, state.forwardSpeed, state.steer,
      ...(state.offsetPos?.toArray() ?? []), ...(state.offsetQuat?.toArray() ?? []), ...(state.wheelY ?? [])]) assert.ok(Number.isFinite(value), 'finite render transform and animation state');
  }
  assert.ok(player.session.alpha >= 0 && player.session.alpha <= 1);
  renderSamples++;
}
function pump() {
  if (!running) return;
  try {
    const now = performance.now();
    for (const [i, player] of players.entries()) {
      if (player.paused || now < player.nextFrame) continue;
      // Real elapsed dt, one frame per opportunity. Never multiply logical frames to
      // make the server clock advance faster; missed deadlines are ordinary late frames.
      const dt = (now - player.lastFrame) / 1000;
      player.lastFrame = now; player.nextFrame = now + 1000 / player.rate;
      const game = player.session.game;
      const before = game?.tick ?? 0;
      const input: CarInput = driving ? { ...EMPTY_INPUT, throttle: 1, steer: i % 2 ? .12 : -.12, boost: true } : EMPTY_INPUT;
      player.session.update(input, dt, false); player.frames++;
      if (game && player.session.game === game && game.tick > before) player.predictedSteps++;
      if (game && player.synchronizedGame === game && player.frames % 25 === 0) finiteRender(player);
    }
    assert.equal(ended.length, 0, `unexpected onEnded: ${ended.join(', ')}`);
  } catch (error) { driverError = error; running = false; }
  if (running) driver = setTimeout(pump, 1);
}
async function runFor(ms: number) { await delay(ms); if (driverError) throw driverError; }
const socket = (player: Player) => player.browser.sockets.at(-1)!;
async function add(browser: Browser, admission: RoomAdmission, i: number) {
  const session = await context.run(browser, () => ServerRoomSession.create(admission, `QA ${i}`, .5, i % 3));
  const now = performance.now();
  const player: Player = { browser, session, rate: i % 2 ? 240 : 120, frames: 0, starts: 0, updates: 0,
    synchronizedGame: null, predictedSteps: 0, paused: false, lastFrame: now, nextFrame: now };
  session.onEnded = reason => { ended.push(reason); };
  session.onMatchStarted = () => { player.starts++; player.synchronizedGame = session.game; };
  session.onLobbyChanged = () => { player.updates++; };
  players.push(player); return player;
}
let ready = false;
let healthPending = false;
const healthPoll = setInterval(() => {
  if (ready || healthPending) return;
  healthPending = true;
  void fetch(`${origin}/game/health`, { signal: AbortSignal.timeout(1000) }).then(response => { ready = response.ok; })
    .catch(() => {}).finally(() => { healthPending = false; });
}, 50);
try {
  await wait('ephemeral server health', () => {
    if (childError) throw childError;
    if (child.exitCode !== null) throw new Error(`Server exited ${child.exitCode}`);
    return ready;
  });
  const ownerBrowser = new Browser();
  check((await ownerBrowser.request('/game/status')).status === 200, 'HTTP status endpoint available');
  check((await ownerBrowser.request('/game/rooms', { teamSize: 1 })).status === 401, 'HTTP admission requires authentication');
  check((await ownerBrowser.request('/game/login', { password })).status === 200, 'ephemeral password grants owner cookie');
  const teamSize = Number(process.env.SERVER_PLAY_TEAM_SIZE ?? 1);
  assert.ok(teamSize === 1 || teamSize === 4, 'SERVER_PLAY_TEAM_SIZE must be 1 or 4');
  const created = await ownerBrowser.request<RoomAdmission>('/game/rooms', { teamSize });
  assert.equal(created.status, 201);
  const owner = await add(ownerBrowser, created.data, 0);
  for (let i = 1; i < teamSize * 2; i++) {
    const browser = new Browser();
    const admitted = await browser.request<RoomAdmission>('/game/invite', { token: new URL(created.data.inviteUrl!).hash.slice(6) });
    assert.equal(admitted.status, 200); await add(browser, admitted.data, i);
  }
  await wait('all real sessions in lobby', () => players.every(p => p.session.lobby.players.length === players.length));
  check(owner.session.lobby.isHost && players.slice(1).every(p => !p.session.lobby.isHost), `${teamSize}v${teamSize} actual sessions retain owner/guest authority`);
  owner.session.setMatchSeconds(0);
  players.at(-1)!.session.setBody(2);
  await wait('lobby settings and cosmetic update', () => players.every(p => p.session.lobby.settings.matchSeconds === 0 && p.session.lobby.players.at(-1)?.body === 2));
  check(players.every(p => p.updates > 0), 'onLobbyChanged delivers real control updates');
  running = true; pump();
  owner.session.command('start');
  await wait('real client prediction started', () => players.every(p => !!p.session.game && p.starts === 1 && p.session.stats.snapshots > 0));
  await wait('kickoff finishes', () => players.every(p => p.session.game?.phase === 'play'));
  const beforeMove = socket(owner).latest!.cars.map(c => ({ id: c.id, ...c.state.pos }));
  const beforeTicks = players.map(p => p.session.game!.tick);
  const beforeSnapshots = players.map(p => p.session.stats.snapshots);
  driving = true; await runFor(1800);
  const authoritative = socket(owner).latest!;
  check(beforeMove.every(before => {
    const car = authoritative.cars.find(c => c.id === before.id)!;
    return Math.hypot(car.state.pos.x - before.x, car.state.pos.z - before.z) > .1;
  }), 'every actual client input stream moves its car in authoritative worker snapshots');
  check(players.every((p, i) => p.session.game!.tick > beforeTicks[i] + 30 && p.session.stats.snapshots > beforeSnapshots[i] + 5), 'ticks and accepted snapshots progress under wall-clock 120/240 Hz frame calls');
  check(players.every(p => p.predictedSteps > 0 && socket(p).ack >= 0 && socket(p).inputs > 0), 'actual ClientSession predicts synchronously and server acknowledges its input packets');
  check(players.every(p => p.session.ping !== null && Number.isFinite(p.session.ping) && socket(p).pings > 0 && socket(p).pongs > 0), 'real ping/pong updates session RTT');
  players.forEach(finiteRender);
  const paused = players.at(-1)!;
  paused.paused = true;
  const pausedFrames = paused.frames;
  const pausedSnapshots = paused.session.stats.snapshots;
  const activeTick = owner.session.game!.tick;
  await runFor(900);
  check(paused.frames === pausedFrames && paused.session.stats.snapshots > pausedSnapshots && owner.session.game!.tick > activeTick + 20,
    'one stopped frame loop still receives snapshots while other clients and worker continue');
  paused.paused = false; // lastFrame stays unchanged: resume receives the actual elapsed dt.
  await runFor(600); finiteRender(paused);
  const sameSession = paused.session;
  const seat = paused.session.localId;
  const oldSocket = socket(paused);
  const reconnectTick = oldSocket.latest!.tick;
  const oldStarts = paused.starts;
  const reconnectPosition = oldSocket.latest!.cars.find(c => c.id === seat)!.state.pos;
  oldSocket.close(1000, 'QA ordinary disconnect');
  await wait('SocketLink reconnect with same cookie context', () => paused.browser.sockets.length === 2 && socket(paused).readyState === NodeSocket.OPEN && paused.starts > oldStarts && (socket(paused).latest?.tick ?? 0) > reconnectTick);
  await runFor(700);
  const restoredPosition = socket(paused).latest!.cars.find(c => c.id === seat)!.state.pos;
  check(paused.session === sameSession && paused.session.localId === seat && socket(paused).ack >= 0
    && Math.hypot(restoredPosition.x - reconnectPosition.x, restoredPosition.z - reconnectPosition.z) > .1,
    'normal WebSocket reconnect restores same ClientSession seat, progress and acknowledged prediction');
  check(players.every(p => !socket(p).controls.some(c => c.t === 'reject')) && ended.length === 0, 'reconnect and authenticated traffic cause no rejection or unexpected onEnded');
  check(Browser.all.every(browser => browser.sockets.every(ws => ws.preAdmissionBinaries === 0)),
    'initial and replacement sockets send no gameplay packets before server admission');
  const epochs = players.map(p => socket(p).epoch);
  const games = players.map(p => p.session.game);
  const starts = players.map(p => p.starts);
  owner.session.resetMatch();
  await wait('rematch generation', () => players.every((p, i) => socket(p).epoch > epochs[i] && p.starts > starts[i] && p.session.game !== games[i]));
  await runFor(500);
  check(players.every(p => p.session.game!.score.blue === 0 && p.session.game!.score.orange === 0 && p.session.game!.phase === 'countdown'), 'rematch replaces prediction worlds and resets score/countdown in new epoch');
  players.forEach(finiteRender);
  check(renderSamples > 0 && players.every(p => p.session.stats.snapshots > 10), 'finite carRenderStates remain available across play, pause, reconnect and rematch');
  owner.session.command('end');
  await wait('clean room end', () => players.every(p => !p.session.game && !p.session.lobby.inMatch));
  check(ended.length === 0 && players.every(p => socket(p).controls.some(c => c.t === 'end')), 'explicit match end clears every prediction world without ending room sessions');
  running = false; clearTimeout(driver);
  // Room close intentionally ends sessions, after the no-unexpected-end assertions.
  owner.session.command('close');
  await wait('room close', () => players.every(p => socket(p).readyState === NodeSocket.CLOSED));
  const metrics = await ownerBrowser.request<{ rooms: number }>('/game/metrics');
  check(metrics.data.rooms === 0, 'owner closes and destroys the ephemeral room');
  console.log(JSON.stringify({ checks, teamSize, renderSamples, clients: players.map(p => ({ rate: p.rate, frames: p.frames,
    starts: p.starts, updates: p.updates, predictedSteps: p.predictedSteps, ...p.session.stats })) }));
  console.log('Headless actual-client localhost acceptance only; no WebGL, browser, physical LAN or latency-performance acceptance.');
} catch (error) {
  console.error(`Socket admission diagnostics: ${JSON.stringify(Browser.all.map(browser => browser.sockets.map(ws => ({ preAdmissionBinaries: ws.preAdmissionBinaries, inputs: ws.inputs, pings: ws.pings }))))}`);
  console.error(`Bounded child logs:\n${logs}`); throw error;
} finally {
  clearInterval(healthPoll); running = false; clearTimeout(driver);
  for (const player of players) {
    try { player.session.leave(); } catch (error) { console.error(`Cleanup: ${String(error).slice(0, 300)}`); }
  }
  for (const browser of Browser.all) for (const ws of browser.sockets) ws.terminate();
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 2000);
    await exited; clearTimeout(force);
  }
}
