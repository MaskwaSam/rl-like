import { ARENAS } from '../src/arenas';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { randomBytes, scryptSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import { Game } from '../src/sim/game';
import { ByteReader } from '../src/sim/state';
import { EMPTY_INPUT } from '../src/input/types';
import { encodeInputs } from '../src/net/protocol';
import { RoomAuthority } from '../server/authority';

let checks = 0;
const check = (value: unknown, description: string) => { if (!value) throw new Error(description); checks++; console.log(`PASS ${description}`); };
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (predicate: () => unknown, ms = 6000) => { const end = Date.now() + ms; while (!predicate()) { if (Date.now() > end) throw new Error('Timed out waiting for room state'); await delay(10); } };
const origin = 'http://127.0.0.1:4211';
const password = randomBytes(24).toString('base64url');
const salt = randomBytes(16);
const hash = `${salt.toString('hex')}:${scryptSync(password, salt, 64).toString('hex')}`;
let server: ReturnType<typeof spawn>;
async function start(ttl = 1800) {
  server = spawn(process.execPath, ['.server-build/index.js'], { env: { ...process.env, PORT: '4211', CAR_ORIGIN: origin, CAR_PASSWORD_HASH: hash, CAR_ROOM_TTL_SECONDS: String(ttl) }, stdio: ['ignore', 'ignore', 'pipe'] });
  server.stderr?.on('data', () => {});
  await wait(asyncReady, 6000);
}
let ready = false;
function asyncReady() { void fetch(`${origin}/game/health`).then(r => { ready = r.ok; }).catch(() => {}); return ready; }
async function stop() { ready = false; server.kill('SIGTERM'); await new Promise(resolve => server.once('exit', resolve)); }
class Browser {
  cookies = new Map<string, string>();
  header() { return [...this.cookies].map(([a, b]) => `${a}=${b}`).join('; '); }
  async request(path: string, body?: unknown, customOrigin = origin) {
    const response = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: this.header(), ...(body === undefined ? {} : { Origin: customOrigin, 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    for (const value of response.headers.getSetCookie()) { const [name, cookie] = value.split(';')[0].split('='); if (cookie) this.cookies.set(name, cookie); else this.cookies.delete(name); }
    let data: any = null; try { data = await response.json(); } catch {}
    return { response, data };
  }
  pausePost(path: string, body: unknown) {
    const data = JSON.stringify(body);
    let started!: () => void;
    let finish!: () => void;
    const paused = new Promise<void>(resolve => { started = resolve; });
    const result = new Promise<number>((resolve, reject) => {
      const req = httpRequest(origin + path, { method: 'POST', headers: { Cookie: this.header(), Origin: origin,
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      req.on('error', reject); req.write(data.slice(0, -1), () => started());
      finish = () => req.end(data.slice(-1));
    });
    return { paused, result, finish: () => finish() };
  }
}
class Player {
  ws: WebSocket;
  ctrl: any[] = [];
  state: ReturnType<typeof Game.decode> | null = null;
  epoch = 0;
  slot = -1;
  closed = 0;
  constructor(browser: Browser, name: string, body = 0) {
    this.ws = new WebSocket(origin.replace('http', 'ws') + '/game/ws', { headers: { Cookie: browser.header(), Origin: origin } });
    this.ws.on('open', () => this.send({ t: 'hello', name, version: 3, body, dodgeDeadzone: 0.5 }));
    this.ws.on('error', () => {});
    this.ws.on('close', code => { this.closed = code; });
    this.ws.on('message', (raw, binary) => {
      const bytes = raw as Buffer;
      if (!binary) { const msg = JSON.parse(bytes.toString()); this.ctrl.push(msg); if (msg.t === 'welcome') this.slot = msg.slot; if (msg.t === 'start') this.epoch = msg.epoch; return; }
      if (bytes[4] !== 2 || bytes.readUInt32LE(0) !== this.epoch) return;
      const buffer = Uint8Array.from(bytes.subarray(13)).buffer;
      this.state = Game.decode(new ByteReader(buffer));
    });
  }
  send(message: unknown) { this.ws.send(JSON.stringify(message)); }
  input(throttle = 1) {
    const first = (this.state?.tick ?? 0) + 3;
    const input = encodeInputs(first, Array.from({ length: 12 }, () => ({ ...EMPTY_INPUT, throttle, boost: true, airRoll: true })));
    const bytes = new Uint8Array(4 + input.byteLength); new DataView(bytes.buffer).setUint32(0, this.epoch, true); bytes.set(new Uint8Array(input), 4); this.ws.send(bytes);
  }
  lobby() { return this.ctrl.findLast(m => m.t === 'lobby'); }
}
await start();
const sockets: Player[] = [];
try {
  const outsider = new Browser();
  check((await outsider.request('/game/status')).data.access === 'none', 'anonymous entry is locked');
  const manifest = JSON.parse(readFileSync('dist/.vite/manifest.json', 'utf8'));
  check((await outsider.request('/' + manifest['index.html'].file)).response.ok, 'small password-page bundle is public');
  const backdrop = await outsider.request('/' + manifest['src/assets/maskwa-login.jpg'].file);
  check(backdrop.response.ok && backdrop.response.headers.get('content-type') === 'image/jpeg'
    && backdrop.response.headers.get('cache-control') === 'public, max-age=31536000, immutable', 'Maskwa login backdrop is public with image type and immutable cache');
  for (const artwork of ['src/assets/maskwa-bear.png', 'src/assets/mchs-logo.png']) {
    check((await outsider.request('/' + manifest[artwork].file)).response.status === 401, `original arena artwork remains protected: ${artwork}`);
  }
  check((await outsider.request('/' + manifest['src/main.ts'].file)).response.status === 401, 'game bundle is server-protected before admission');
  check((await outsider.request('/game/rooms', { teamSize: 4 })).response.status === 401, 'anonymous room creation denied');
  const ownerBrowser = new Browser();
  check((await ownerBrowser.request('/game/login', { password: 'wrong' })).response.status === 401, 'wrong password denied');
  check((await ownerBrowser.request('/game/login', { password }, 'https://foreign.invalid')).response.status === 403, 'foreign origin denied');
  const login = await ownerBrowser.request('/game/login', { password });
  check(login.response.ok && login.response.headers.getSetCookie()[0].includes('HttpOnly') && login.response.headers.getSetCookie()[0].includes('SameSite=Strict'), 'password login issues protected session cookie');
  for (const teamSize of [1, 2, 3, 4]) {
    const created = await ownerBrowser.request('/game/rooms', { teamSize });
    const room = created.data;
    check(created.response.status === 201 && room.code.length === 8 && room.inviteUrl.includes('#join='), `${teamSize}v${teamSize} private code/link created`);
    const invite = new URL(room.inviteUrl).hash.slice(6);
    const owner = new Player(ownerBrowser, 'Owner', 2); sockets.push(owner); await wait(() => owner.slot >= 0);
    const players = [owner];
    const guests: Browser[] = [];
    for (let i = 1; i < teamSize * 2; i++) {
      const guest = new Browser(); guests.push(guest);
      check((await guest.request('/game/invite', { token: invite })).response.ok, `${teamSize}v${teamSize} invite admission ${i}`);
      const player = new Player(guest, `Friend ${i}`, i % 3); sockets.push(player); players.push(player); await wait(() => player.slot >= 0);
    }
    await wait(() => owner.lobby()?.players.length === teamSize * 2);
    check(owner.lobby().players.filter((p: any) => p.team === 'blue').length === teamSize, `${teamSize}v${teamSize} balances all human slots`);
    const extra = new Browser(); await extra.request('/game/invite', { token: invite });
    const fullPlayer = new Player(extra, 'Extra'); sockets.push(fullPlayer);
    await wait(() => fullPlayer.ctrl.some(m => m.t === 'reject'));
    check(fullPlayer.ctrl.some(m => m.reason?.includes('full')), `${teamSize}v${teamSize} excess player rejected`);
    check((await guests[0].request('/game/rooms', { teamSize: 1 })).response.status === 401 && (await guests[0].request('/game/join', { code: room.code })).response.status === 401, `${teamSize}v${teamSize} invite grants no create/code-join authority`);
    const arena = teamSize - 1;
    owner.send({ t: 'settings', arena });
    await wait(() => players.every(p => p.lobby()?.settings.arena === arena));
    check(true, `${teamSize}v${teamSize} chosen arena reaches all players`);
    owner.send({ t: 'room-command', action: 'start' }); await wait(() => players.every(p => p.state?.cars.length === teamSize * 2));
    check(players.every(p => p.ctrl.findLast(m => m.t === 'start')?.config.arena === arena), `${teamSize}v${teamSize} start carries the chosen arena`);
    check(players.every(p => p.state!.cars.some(c => c.id === p.slot)), `${teamSize}v${teamSize} authoritative snapshots include every human`);
    await wait(() => owner.state?.phase === 'play', 6000);
    const before = owner.state!.cars.map(c => ({ id: c.id, x: c.state.pos.x, z: c.state.pos.z }));
    const timer = setInterval(() => players.forEach(p => p.input()), 25);
    await delay(700); clearInterval(timer);
    check(before.every(a => { const car = owner.state!.cars.find(c => c.id === a.id)!; return Math.hypot(car.state.pos.x - a.x, car.state.pos.z - a.z) > .1; }), `${teamSize}v${teamSize} all streams drive with boost and air roll flags`);
    const epoch = owner.epoch;
    owner.send({ t: 'room-command', action: 'reset' }); await wait(() => owner.epoch > epoch && players.every(p => p.epoch === owner.epoch));
    check(owner.state!.score.blue === 0, `${teamSize}v${teamSize} rematch resets with new epoch`);
    owner.send({ t: 'room-command', action: 'end' }); await wait(() => owner.lobby()?.inMatch === false);
    const reconnect = new Player(guests[0], 'Reconnect'); sockets.push(reconnect); await wait(() => reconnect.slot >= 0);
    check(reconnect.slot === players[1].slot && reconnect.ctrl.some(m => m.t === 'end'), `${teamSize}v${teamSize} reconnect restores seat and authoritative lobby end`);
    owner.send({ t: 'room-command', action: 'rotate' }); await wait(() => owner.ctrl.filter(m => m.t === 'welcome').length >= 2);
    check((await outsider.request('/game/invite', { token: invite })).response.status === 410 && (await guests[0].request('/game/status')).data.access === 'none', `${teamSize}v${teamSize} rotation revokes old link and scoped guest grant`);
    owner.send({ t: 'room-command', action: 'close' }); await wait(() => owner.closed !== 0);
    check((await ownerBrowser.request('/game/metrics')).data.rooms === 0, `${teamSize}v${teamSize} close destroys room`);
  }
  // A compromised invite client cannot impersonate owner commands.
  const room = (await ownerBrowser.request('/game/rooms', { teamSize: 1 })).data;
  const owner = new Player(ownerBrowser, 'Owner'); sockets.push(owner); await wait(() => owner.slot >= 0);
  const guestBrowser = new Browser(); await guestBrowser.request('/game/invite', { token: new URL(room.inviteUrl).hash.slice(6) });
  const attacker = new Player(guestBrowser, 'Guest'); sockets.push(attacker); await wait(() => attacker.slot >= 0);
  attacker.send({ t: 'room-command', action: 'close' }); await wait(() => attacker.closed !== 0);
  check((await ownerBrowser.request('/game/metrics')).data.rooms === 1, 'guest owner-command spoof denied without closing room');
  const malformed = new Player(guestBrowser, 'Guest'); sockets.push(malformed); await wait(() => malformed.slot >= 0);
  malformed.ws.send(new Uint8Array([0, 0, 0, 0, 1])); await wait(() => malformed.closed !== 0);
  check(malformed.closed === 4400, 'malformed input closes only offending connection');
  const restored = new Player(guestBrowser, 'Guest'); sockets.push(restored); await wait(() => restored.slot >= 0);
  const silent = new WebSocket(origin.replace('http', 'ws') + '/game/ws', { headers: { Cookie: guestBrowser.header(), Origin: origin } });
  let silentClosed = 0; silent.on('error', () => {}); silent.on('close', code => { silentClosed = code; });
  await wait(() => restored.closed === 4401);
  const replacedAt = Date.now();
  await wait(() => silentClosed !== 0, 17000);
  check(silentClosed === 4400, 'replacement that sends no hello is disconnected');
  await delay(Math.max(0, 31000 - (Date.now() - replacedAt)));
  const newcomerBrowser = new Browser(); await newcomerBrowser.request('/game/invite', { token: new URL(room.inviteUrl).hash.slice(6) });
  const newcomer = new Player(newcomerBrowser, 'New friend'); sockets.push(newcomer); await wait(() => newcomer.slot >= 0);
  check(newcomer.slot === restored.slot, 'no-hello replacement releases its old seat after reconnect grace');
  const paused = ownerBrowser.pausePost('/game/join', { code: room.code });
  const pausedCreate = ownerBrowser.pausePost('/game/rooms', { teamSize: 1 });
  await Promise.all([paused.paused, pausedCreate.paused]); await delay(50);
  await ownerBrowser.request('/game/logout', {}); await wait(() => owner.closed !== 0);
  paused.finish(); pausedCreate.finish();
  check(await paused.result === 401, 'logout revokes authorization of a request paused during body parsing');
  check(await pausedCreate.result === 401, 'logout prevents paused room creation from restoring access');
  check((await ownerBrowser.request('/game/status')).data.access === 'none', 'logout revokes live authority and cookies');
} finally { sockets.forEach(s => s.ws.close()); await stop(); }

// Exercise asynchronous start cancellation without timing-dependent network guesses.
const lifecycle: any[] = [];
const authority = new RoomAuthority('owner', 1, (_, m) => lifecycle.push(m), () => {});
authority.admit('owner', { t: 'hello', name: 'Owner', version: 3, body: 0, dodgeDeadzone: .5 });
authority.control('owner', { t: 'room-command', action: 'start' }); authority.control('owner', { t: 'room-command', action: 'end' });
await delay(100);
check(authority.game === null && !lifecycle.some(m => m.t === 'start'), 'end cancels pending asynchronous match start');
authority.admit('guest', { t: 'hello', name: 'Guest', version: 3, body: 0, dodgeDeadzone: .5 });
check(!authority.control('guest', { t: 'settings', arena: 2 }) && authority.arena === 0, 'guest cannot change room arena');
for (const invalid of [-1, ARENAS.length, 1.5, '1', null, {}, Infinity]) {
  check(!authority.control('owner', { t: 'settings', arena: invalid }) && authority.arena === 0, `invalid arena rejected: ${String(invalid)}`);
}
check(authority.control('owner', { t: 'settings', arena: 2 }) && authority.arena === 2, 'owner chooses industrial arena before play');
authority.control('owner', { t: 'room-command', action: 'start' });
check(!authority.control('owner', { t: 'settings', arena: 1 }), 'arena cannot change while match start is pending');
await wait(() => !!authority.game);
check(authority.game!.config.arena === 2 && !authority.control('owner', { t: 'settings', arena: 0 }) && authority.arena === 2, 'active match retains its arena');
authority.control('owner', { t: 'room-command', action: 'end' });
check(authority.control('owner', { t: 'settings', arena: 1 }), 'owner can choose a different arena after match ends');
authority.destroy();

await start(3);
try {
  const owner = new Browser(); await owner.request('/game/login', { password });
  const room = (await owner.request('/game/rooms', { teamSize: 1 })).data;
  await delay(3400);
  check((await owner.request('/game/invite', { token: new URL(room.inviteUrl).hash.slice(6) })).response.status === 410, 'expired room invite rejected');
} finally { await stop(); }
console.log(`PASS ${checks} private-room integration checks; real HTTP/WebSocket workers and Rapier, localhost only.`);
