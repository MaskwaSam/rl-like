/** Real HTTP/WebSocket checks for the optional watch-only hostname. Ephemeral test password only. */
import { spawn, spawnSync } from 'node:child_process';
import { request } from 'node:http';
import { randomBytes, scryptSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';

let checks = 0;
const check = (value: unknown, description: string) => { if (!value) throw new Error(description); checks++; console.log(`PASS ${description}`); };
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const port = 4213;
const game = `http://127.0.0.1:${port}`;
const spectator = `http://localhost:${port}`;
const password = randomBytes(24).toString('base64url');
const salt = randomBytes(16);
const hash = `${salt.toString('hex')}:${scryptSync(password, salt, 64).toString('hex')}`;
const env = { ...process.env, PORT: String(port), CAR_ORIGIN: game, CAR_PASSWORD_HASH: hash };

/** node:http so the Host header can name either origin while connecting to 127.0.0.1. */
class Browser {
  cookies = new Map<string, string>();
  constructor(readonly site: string) {}
  call(path: string, body?: unknown, originHeader = this.site): Promise<{ status: number; data: any; cookies: string[] }> {
    const payload = body === undefined ? '' : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method: body === undefined ? 'GET' : 'POST', headers: {
        Host: new URL(this.site).host, Cookie: [...this.cookies].map(([a, b]) => `${a}=${b}`).join('; '),
        ...(body === undefined ? {} : { Origin: originHeader, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }),
      } }, res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
          for (const value of cookies) { const [name, cookie] = value.split(';')[0].split('='); if (cookie) this.cookies.set(name, cookie); else this.cookies.delete(name); }
          let data: any = null; try { data = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
          resolve({ status: res.statusCode!, data, cookies });
        });
      });
      req.on('error', reject); req.end(payload);
    });
  }
  upgrade(): Promise<number | 'open'> {
    return new Promise(resolve => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/game/ws`, { headers: { Host: new URL(this.site).host, Origin: this.site, Cookie: [...this.cookies].map(([a, b]) => `${a}=${b}`).join('; ') } });
      ws.on('open', () => { ws.close(); resolve('open'); });
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', () => resolve(0));
    });
  }
}

for (const bad of [game, 'https://carspectator.invalid', 'http://carspectator.example']) {
  const run = spawnSync(process.execPath, ['.server-build/index.js'], { env: { ...env, CAR_SPECTATOR_ORIGIN: bad }, encoding: 'utf8', timeout: 5000 });
  check(run.status !== 0 && /CAR_SPECTATOR_ORIGIN|HTTPS/.test(run.stderr), `server refuses unsafe spectator origin ${bad}`);
}

const server = spawn(process.execPath, ['.server-build/index.js'], { env: { ...env, CAR_SPECTATOR_ORIGIN: spectator }, stdio: ['ignore', 'ignore', 'pipe'] });
server.stderr?.on('data', () => {});
try {
  const probe = new Browser(spectator);
  for (let i = 0; i < 300; i++) { try { if ((await probe.call('/healthz')).status === 200) break; } catch {} await delay(20); }
  const manifest = JSON.parse(readFileSync('dist/.vite/manifest.json', 'utf8'));
  const gameBundle = '/' + manifest['src/main.ts'].file;
  const spectatorBundle = '/' + manifest['src/spectator/main.ts'].file;

  const viewer = new Browser(spectator);
  check((await viewer.call('/game/status')).data.access === 'none', 'spectator host starts locked');
  check((await viewer.call('/')).status === 200 && (await viewer.call('/' + manifest['index.html'].file)).status === 200, 'spectator host serves the public password page');
  check((await viewer.call(spectatorBundle)).status === 401 && (await viewer.call(gameBundle)).status === 401, 'spectator and game bundles are protected before login');
  check((await viewer.call('/game/login', { password }, game)).status === 403, 'spectator login rejects the game origin header');
  check((await viewer.call('/game/login', { password: 'wrong' })).status === 401, 'spectator host rejects a wrong password');
  const login = await viewer.call('/game/login', { password });
  check(login.status === 200 && login.cookies[0]?.includes('HttpOnly') && login.cookies[0]?.includes('SameSite=Strict'), 'same game password logs into the spectator host');
  check((await viewer.call('/game/status')).data.access === 'password', 'spectator session is recognised');
  check((await viewer.call(spectatorBundle)).status === 200, 'spectator bundle is served after login');
  for (const path of ['/game/rooms', '/game/join', '/game/invite', '/game/leave']) {
    check((await viewer.call(path, { teamSize: 1, code: 'ABCDEFGH', token: 'x'.repeat(32) })).status === 404, `spectator host has no server-room API: ${path}`);
  }
  check((await viewer.call('/game/metrics')).status === 404, 'spectator host hides room metrics');
  check((await viewer.upgrade()) === 403, 'spectator host refuses server-room WebSockets');

  const player = new Browser(game);
  check((await player.call('/game/status')).data.access === 'none', 'spectator login does not admit the game host');
  check((await player.call('/game/login', { password }, spectator)).status === 403, 'game login rejects the spectator origin header');
  await player.call('/game/login', { password });
  const room = await player.call('/game/rooms', { teamSize: 1 });
  check(room.status === 201, 'game host keeps server rooms with the spectator host configured');
  check((await player.upgrade()) === 'open', 'game host keeps server-room WebSockets');

  const foreign = new Browser('http://elsewhere.invalid');
  check((await foreign.call('/game/status')).status === 403, 'unknown Host header remains rejected');
  check((await viewer.call('/game/logout', {})).status === 200 && (await viewer.call('/game/status')).data.access === 'none', 'spectator logout clears its session');
  console.log(`Spectator host checks passed: ${checks}`);
} finally {
  server.kill('SIGTERM');
}
