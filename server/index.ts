import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { readFileSync, createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import type { CtrlMsg } from '../src/net/protocol';

const origin = new URL(process.env.CAR_ORIGIN ?? 'http://127.0.0.1:5173');
if (origin.origin !== origin.href.replace(/\/$/, '') || !['http:', 'https:'].includes(origin.protocol)) throw new Error('CAR_ORIGIN must be one HTTP(S) origin');
if (origin.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) throw new Error('Public access requires HTTPS');
const passwordHash = process.env.CAR_PASSWORD_HASH_FILE
  ? readFileSync(process.env.CAR_PASSWORD_HASH_FILE, 'utf8').trim() : process.env.CAR_PASSWORD_HASH ?? '';
if (!/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(passwordHash)) throw new Error('Set CAR_PASSWORD_HASH using npm run password:hash; no default password exists');
const [salt, expected] = passwordHash.split(':');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(24).toString('base64url');
const dist = resolve(process.env.CAR_DIST ?? 'dist');
const SESSION_MS = 8 * 60 * 60_000;
const ROOM_SECONDS = Number(process.env.CAR_ROOM_TTL_SECONDS ?? 1800);
if (!Number.isInteger(ROOM_SECONDS) || ROOM_SECONDS < 2 || ROOM_SECONDS > 1800) throw new Error('Room TTL must be 2–1800 seconds');
const ROOM_MS = ROOM_SECONDS * 1000;
const cookieNames = { full: origin.protocol === 'https:' ? '__Host-car-access' : 'car-access', room: origin.protocol === 'https:' ? '__Host-car-room' : 'car-room' };
interface FullGrant { principal: string; expiresAt: number }
interface RoomGrant { principal: string; roomId: string; version: number; guest: boolean; expiresAt: number }
interface Connection { ws: WebSocket; grant: RoomGrant; grantKey: string; admitted: boolean; admissionPending: boolean; binaryCount: number; ctrlCount: number; windowAt: number; slowAt: number; pending: number; id: string }
interface Room {
  id: string; owner: string; code: string; invite: string; inviteHash: string; version: number; teamSize: number;
  expiresAt: number; worker: Worker; connections: Map<string, Connection>; emptySince: number; activityAt: number;
  inMatch: boolean; metrics: Record<string, number>;
}
const fullGrants = new Map<string, FullGrant>();
const roomGrants = new Map<string, RoomGrant>();
const rooms = new Map<string, Room>();
const attempts = new Map<string, { count: number; reset: number }>();
let checkingPasswords = 0;

function limited(key: string, max: number, ms = 60_000): boolean {
  const now = Date.now();
  let bucket = attempts.get(key);
  if (!bucket || bucket.reset <= now) {
    if (!bucket && attempts.size >= 512) return true;
    bucket = { count: 0, reset: now + ms }; attempts.set(key, bucket);
  }
  return ++bucket.count > max;
}
function cookie(req: IncomingMessage, name: string): string {
  const value = (req.headers.cookie ?? '').split(';').map(c => c.trim()).find(c => c.startsWith(`${name}=`))?.slice(name.length + 1) ?? '';
  return /^[A-Za-z0-9_-]{32}$/.test(value) ? value : '';
}
function full(req: IncomingMessage): FullGrant | undefined {
  const grant = fullGrants.get(digest(cookie(req, cookieNames.full)));
  return grant && grant.expiresAt > Date.now() ? grant : undefined;
}
function roomGrant(req: IncomingMessage): RoomGrant | undefined {
  const grant = roomGrants.get(digest(cookie(req, cookieNames.room)));
  const room = grant && rooms.get(grant.roomId);
  return grant && room && room.expiresAt > Date.now() && grant.expiresAt > Date.now() && (!grant.guest || grant.version === room.version) ? grant : undefined;
}
function setCookie(res: ServerResponse, name: string, value: string, seconds: number): void {
  const previous = res.getHeader('Set-Cookie');
  const list = Array.isArray(previous) ? previous : previous ? [String(previous)] : [];
  list.push(`${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, seconds)}${origin.protocol === 'https:' ? '; Secure' : ''}`);
  res.setHeader('Set-Cookie', list);
}
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body));
}
function info(room: Room, grant: RoomGrant, canCreate: boolean) {
  return { roomId: room.id, code: room.code, teamSize: room.teamSize, expiresAt: room.expiresAt,
    canCreate, owner: room.owner === grant.principal,
    ...(room.owner === grant.principal ? { inviteUrl: `${origin.origin}/#join=${room.invite}` } : {}) };
}
function admit(res: ServerResponse, room: Room, principal: string, guest: boolean): RoomGrant {
  const value = token();
  const grant: RoomGrant = { principal, roomId: room.id, version: room.version, guest, expiresAt: room.expiresAt };
  roomGrants.set(digest(value), grant);
  setCookie(res, cookieNames.room, value, Math.floor((room.expiresAt - Date.now()) / 1000));
  return grant;
}
function closeRoom(room: Room, reason: string): void {
  if (!rooms.delete(room.id)) return;
  for (const connection of room.connections.values()) {
    connection.ws.send(JSON.stringify({ t: 'reject', reason })); connection.ws.close(4403, 'Room unavailable');
  }
  for (const [key, grant] of roomGrants) if (grant.roomId === room.id) roomGrants.delete(key);
  room.connections.clear(); void room.worker.terminate();
}
function revokePrincipal(principal: string, reason = 'Signed out'): void {
  const affectedRooms = new Set<string>();
  for (const [key, grant] of roomGrants) if (grant.principal === principal) { affectedRooms.add(grant.roomId); roomGrants.delete(key); }
  for (const room of rooms.values()) {
    const connection = room.connections.get(principal);
    if (!connection && !affectedRooms.has(room.id)) continue;
    room.connections.delete(principal); connection?.ws.close(4403, reason);
    room.worker.postMessage({ type: 'remove', principal });
    if (!room.connections.size) room.emptySince = Date.now();
  }
}
function send(connection: Connection, data: string | Uint8Array, disposable = false): void {
  if (connection.ws.readyState !== WebSocket.OPEN) return;
  if (connection.ws.bufferedAmount > 64 * 1024) {
    connection.slowAt ||= Date.now();
    if (!disposable || Date.now() - connection.slowAt > 5_000) connection.ws.close(4408, 'Slow connection');
    return;
  }
  connection.slowAt = 0; connection.ws.send(data);
}
function createRoom(owner: string, teamSize: number): Room {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const code = [...randomBytes(8)].map(b => alphabet[b & 31]).join('');
  const invite = token();
  const room: Room = { id: token(), owner, code, invite, inviteHash: digest(invite), version: 1, teamSize,
    expiresAt: Date.now() + ROOM_MS, worker: new Worker(new URL('./worker.js', import.meta.url), {
      workerData: { owner, teamSize, snapshotHz: 60 }, resourceLimits: { maxOldGenerationSizeMb: 128 } }),
    connections: new Map(), emptySince: Date.now(), activityAt: Date.now(), inMatch: false, metrics: {} };
  rooms.set(room.id, room);
  room.worker.on('message', event => {
    if (event.type === 'metrics') { room.metrics = event.metrics; return; }
    if (event.type === 'ctrl' || event.type === 'binary') room.worker.postMessage({ type: 'delivered', principal: event.principal, connectionId: event.connectionId });
    const connection = room.connections.get(event.principal);
    if (!connection || event.connectionId !== connection.id) return;
    if (event.type === 'processed') { connection.pending = Math.max(0, connection.pending - 1); return; }
    if (event.type === 'invalid') { connection.ws.close(4400, 'Invalid message'); return; }
    if (event.type === 'ctrl') {
      const message: CtrlMsg = event.message;
      if (message.t === 'welcome') {
        connection.admitted = true;
        message.server = info(room, connection.grant, !connection.grant.guest);
      }
      if (message.t === 'lobby') room.inMatch = message.inMatch;
      send(connection, JSON.stringify(message));
      if (message.t === 'reject') connection.ws.close(4403, 'Room unavailable');
    } else if (event.type === 'binary') {
      const packet = new Uint8Array(4 + event.buffer.byteLength);
      new DataView(packet.buffer).setUint32(0, event.epoch, true); packet.set(new Uint8Array(event.buffer), 4);
      send(connection, packet, true);
    }
  });
  room.worker.on('error', () => closeRoom(room, 'Room stopped. Please ask for a new invite.'));
  room.worker.on('exit', () => closeRoom(room, 'Room stopped. Please ask for a new invite.'));
  return room;
}
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 4096) throw new Error('Payload too large');
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString());
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object');
  return value;
}
async function verifyPassword(value: string): Promise<boolean> {
  checkingPasswords++;
  try {
    const key = await new Promise<Buffer>((resolve, reject) => scrypt(value, Buffer.from(salt, 'hex'), 64,
      { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
    return timingSafeEqual(key, Buffer.from(expected, 'hex'));
  } finally { checkingPasswords--; }
}
const publicFiles = new Set(['/', '/index.html', '/release.json']);
const manifestPath = resolve(dist, '.vite/manifest.json');
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const visit = (key: string) => {
    const item = manifest[key]; if (!item || publicFiles.has(`/${item.file}`)) return;
    publicFiles.add(`/${item.file}`); for (const css of item.css ?? []) publicFiles.add(`/${css}`);
    for (const dependency of item.imports ?? []) visit(dependency);
  };
  visit('index.html');
  // Sam's requested arena backdrop is a public presentation still. Game code
  // and the original school/bear artwork retain their admission requirements.
  visit('src/assets/maskwa-login.jpg');
}
const server = createServer(async (req, res) => {
  res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Cache-Control', 'no-store');
  if (req.headers.host !== origin.host) return json(res, 403, { error: 'Invalid host' });
  try {
    const path = new URL(req.url ?? '/', origin).pathname;
    if (req.method === 'GET' && (path === '/game/health' || path === '/healthz')) return json(res, 200, { ok: true });
    let password = full(req); let scoped = roomGrant(req);
    if (req.method === 'GET' && path === '/game/status') return json(res, 200, {
      access: password ? 'password' : scoped ? 'invite' : 'none',
      ...(scoped ? { room: info(rooms.get(scoped.roomId)!, scoped, !!password) } : {}) });
    if (req.method === 'GET' && path === '/game/metrics') {
      if (!password) return json(res, 401, { error: 'Password required' });
      return json(res, 200, { rooms: rooms.size, connections: [...rooms.values()].reduce((n, r) => n + r.connections.size, 0),
        simulation: [...rooms.values()].map(r => r.metrics) });
    }
    if (req.method === 'POST' && path.startsWith('/game/')) {
      if (req.headers.origin !== origin.origin || !req.headers['content-type']?.startsWith('application/json')) return json(res, 403, { error: 'Same-origin JSON required' });
      const ip = req.socket.remoteAddress ?? 'unknown';
      if (limited(`api:${ip}`, 90) || limited('api:global', 180)) return json(res, 429, { error: 'Too many attempts. Try again shortly.' });
      const body = await readJson(req);
      // Body parsing yields to concurrent logout/leave/expiry requests.
      password = full(req); scoped = roomGrant(req);
      if (path === '/game/login') {
        if (limited(`login:${ip}`, 10) || limited('login:global', 20) || checkingPasswords >= 2) return json(res, 429, { error: 'Too many password attempts. Try again shortly.' });
        if (typeof body.password !== 'string' || body.password.length < 1 || body.password.length > 256 || !await verifyPassword(body.password)) return json(res, 401, { error: 'Password not accepted.' });
        if (fullGrants.size + roomGrants.size >= 128) return json(res, 503, { error: 'Server busy. Try again later.' });
        const value = token(); fullGrants.set(digest(value), { principal: token(), expiresAt: Date.now() + SESSION_MS });
        setCookie(res, cookieNames.full, value, SESSION_MS / 1000); return json(res, 200, { access: 'password' });
      }
      if (path === '/game/logout') {
        if (password) revokePrincipal(password.principal);
        if (scoped) revokePrincipal(scoped.principal);
        fullGrants.delete(digest(cookie(req, cookieNames.full))); roomGrants.delete(digest(cookie(req, cookieNames.room)));
        setCookie(res, cookieNames.full, '', 0); setCookie(res, cookieNames.room, '', 0); return json(res, 200, { ok: true });
      }
      if (path === '/game/leave') {
        if (scoped) revokePrincipal(scoped.principal, 'Left room');
        roomGrants.delete(digest(cookie(req, cookieNames.room))); setCookie(res, cookieNames.room, '', 0); return json(res, 200, { ok: true });
      }
      if (path === '/game/invite') {
        if (limited(`invite:${ip}`, 30)) return json(res, 429, { error: 'Too many attempts. Try again shortly.' });
        if (typeof body.token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(body.token)) return json(res, 410, { error: 'This invite is unavailable. Ask for a new link.' });
        const room = [...rooms.values()].find(r => r.inviteHash === digest(body.token as string) && r.expiresAt > Date.now());
        if (!room) return json(res, 410, { error: 'This invite is unavailable. Ask for a new link.' });
        if (scoped?.roomId === room.id) return json(res, 200, info(room, scoped, !!password));
        if (fullGrants.size + roomGrants.size >= 128) return json(res, 503, { error: 'Server busy. Try again later.' });
        const grant = admit(res, room, password?.principal ?? token(), !password); return json(res, 200, info(room, grant, !!password));
      }
      if (!password) return json(res, 401, { error: 'Password required' });
      if (path === '/game/rooms') {
        if (![1, 2, 3, 4].includes(Number(body.teamSize)) || typeof body.teamSize !== 'number') return json(res, 400, { error: 'Choose 1v1, 2v2, 3v3 or 4v4' });
        if (rooms.size >= 1 || roomGrants.size >= 120) return json(res, 503, { error: 'A server room is already open. Close it before creating another.' });
        const room = createRoom(password.principal, body.teamSize); const grant = admit(res, room, password.principal, false);
        return json(res, 201, info(room, grant, true));
      }
      if (path === '/game/join') {
        const code = typeof body.code === 'string' ? body.code.toUpperCase().replace(/[ -]/g, '') : '';
        const room = [...rooms.values()].find(r => r.code === code && r.expiresAt > Date.now());
        if (!/^[A-Z2-9]{8}$/.test(code) || !room) return json(res, 404, { error: 'Code unavailable. Check it or ask for a fresh invite.' });
        if (scoped?.roomId !== room.id && fullGrants.size + roomGrants.size >= 128) return json(res, 503, { error: 'Server busy. Try again later.' });
        const grant = scoped?.roomId === room.id ? scoped : admit(res, room, password.principal, false);
        return json(res, 200, info(room, grant, true));
      }
      return json(res, 404, { error: 'Not found' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' });
    if (path.startsWith('/game/')) return json(res, 404, { error: 'Not found' });
    if (!publicFiles.has(path) && !password && !scoped) return json(res, 401, { error: 'Password or active room invite required' });
    const file = resolve(dist, `.${decodeURIComponent(path === '/' ? '/index.html' : path)}`);
    if (!file.startsWith(dist + sep) || path.split('/').some(part => part.startsWith('.')) || !existsSync(file) || !statSync(file).isFile()) return json(res, 404, { error: 'Not found' });
    const extension = file.split('.').pop()!;
    const mime: Record<string, string> = { html: 'text/html', js: 'text/javascript', css: 'text/css', json: 'application/json', png: 'image/png', jpg: 'image/jpeg', svg: 'image/svg+xml', wasm: 'application/wasm' };
    res.setHeader('Content-Type', mime[extension] ?? 'application/octet-stream');
    if (path.startsWith('/assets/')) res.setHeader('Cache-Control', `${publicFiles.has(path) ? 'public' : 'private'}, max-age=31536000, immutable`);
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).on('error', () => res.destroy()).pipe(res);
  } catch { if (!res.headersSent) json(res, 400, { error: 'Invalid request' }); else res.destroy(); }
});
server.requestTimeout = 10_000; server.headersTimeout = 10_000; server.maxHeadersCount = 32;
const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
server.on('upgrade', (req, socket, head) => {
  const grant = roomGrant(req);
  if (req.url !== '/game/ws' || req.headers.host !== origin.host || req.headers.origin !== origin.origin || !grant || limited('upgrade:global', 60)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
  }
  const room = rooms.get(grant.roomId)!;
  if (room.connections.size >= 16 && !room.connections.has(grant.principal)) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => {
    const previous = room.connections.get(grant.principal);
    if (previous) {
      room.worker.postMessage({ type: 'disconnect', principal: grant.principal, connectionId: previous.id });
      previous.ws.close(4401, 'Reconnected elsewhere');
    }
    const connection: Connection = { ws, grant, grantKey: digest(cookie(req, cookieNames.room)), admitted: false, admissionPending: false, ctrlCount: 0, binaryCount: 0, windowAt: Date.now(), slowAt: 0, pending: 0, id: token() };
    room.connections.set(grant.principal, connection); room.emptySince = 0;
    const helloTimer = setTimeout(() => { if (!connection.admitted) ws.close(4400, 'Hello required'); }, 15_000);
    let alive = true;
    ws.on('pong', () => { alive = true; });
    const heartbeat = setInterval(() => { if (!alive) ws.terminate(); else { alive = false; ws.ping(); } }, 20_000);
    ws.on('message', (raw, isBinary) => {
      if (room.connections.get(grant.principal) !== connection || ws.readyState !== WebSocket.OPEN) return;
      if (roomGrants.get(connection.grantKey) !== grant) { ws.close(4403, 'Admission revoked'); return; }
      if (grant.expiresAt <= Date.now() || (grant.guest && grant.version !== room.version)) { ws.close(4403, 'Invite expired'); return; }
      if (Date.now() - connection.windowAt >= 1000) { connection.windowAt = Date.now(); connection.binaryCount = 0; connection.ctrlCount = 0; }
      const post = (message: Record<string, unknown>) => {
        if (++connection.pending > 64) { ws.close(4408, 'Input queue full'); return; }
        room.worker.postMessage({ ...message, principal: grant.principal, connectionId: connection.id });
      };
      const bytes = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (isBinary) {
        if (!connection.admitted || ++connection.binaryCount > 120 || bytes.byteLength > 202 || bytes.byteLength < 5) { ws.close(4400, 'Invalid packet'); return; }
        const epoch = bytes.readUInt32LE(0);
        const buffer = Uint8Array.from(bytes.subarray(4)).buffer;
        post({ type: 'binary', epoch, buffer });
        return;
      }
      if (++connection.ctrlCount > 10) { ws.close(4408, 'Control rate exceeded'); return; }
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(bytes.toString()); if (!msg || typeof msg !== 'object' || Array.isArray(msg)) throw new Error(); }
      catch { ws.close(4400, 'Invalid message'); return; }
      room.activityAt = Date.now();
      if (!connection.admitted) {
        if (msg.t !== 'hello' || connection.admissionPending) { ws.close(4400, 'Hello required'); return; }
        connection.admissionPending = true;
        post({ type: 'admit', message: msg }); return;
      }
      if (msg.t === 'room-command' && (msg.action === 'close' || msg.action === 'rotate')) {
        if (grant.guest || grant.principal !== room.owner) { ws.close(4403, 'Owner required'); return; }
        if (msg.action === 'close') { closeRoom(room, 'The owner closed this room.'); return; }
        room.version++; room.invite = token(); room.inviteHash = digest(room.invite);
        room.code = [...randomBytes(8)].map(b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b & 31]).join('');
        for (const [key, g] of roomGrants) if (g.roomId === room.id && g.guest) {
          roomGrants.delete(key); room.worker.postMessage({ type: 'remove', principal: g.principal });
          room.connections.get(g.principal)?.ws.close(4403, 'Invite revoked');
        }
        room.worker.postMessage({ type: 'refresh' });
      } else post({ type: 'control', message: msg });
    });
    ws.on('error', () => ws.close());
    ws.on('close', () => {
      clearTimeout(helloTimer); clearInterval(heartbeat);
      if (room.connections.get(grant.principal) !== connection) return;
      room.connections.delete(grant.principal); room.worker.postMessage({ type: 'disconnect', principal: grant.principal, connectionId: connection.id });
      if (!room.connections.size) room.emptySince = Date.now();
    });
  });
});
setInterval(() => {
  const now = Date.now();
  for (const [key, grant] of fullGrants) if (grant.expiresAt <= now) fullGrants.delete(key);
  for (const [key, grant] of roomGrants) if (grant.expiresAt <= now || !rooms.has(grant.roomId)) roomGrants.delete(key);
  for (const [key, bucket] of attempts) if (bucket.reset <= now) attempts.delete(key);
  for (const room of rooms.values()) if (room.expiresAt <= now || (room.emptySince && now - room.emptySince > 60_000) || (!room.inMatch && now - room.activityAt > 5 * 60_000)) closeRoom(room, 'Room expired. Ask for a new invite.');
}, 1000).unref();
server.listen(Number(process.env.PORT ?? 4100), process.env.CAR_BIND ?? '127.0.0.1', () => console.info(`Car Soccer private rooms ready for ${origin.origin}`));
function shutdown() {
  for (const room of rooms.values()) closeRoom(room, 'Server restarting.'); server.close();
  setTimeout(() => { for (const ws of wss.clients) ws.terminate(); process.exit(0); }, 5000).unref();
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
