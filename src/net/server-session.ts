import type { Vector3 } from 'three';
import { ClientSession } from './client';
import type { GameLink } from './channel';
import type { CtrlMsg } from './protocol';
import type { CarInput } from '../input/types';
import type { Session } from './session';
import type { RoomAdmission } from '../access';

class SocketLink implements GameLink {
  onCtrl: ((msg: CtrlMsg) => void) | null = null;
  onFast: ((buffer: ArrayBuffer) => void) | null = null;
  onClose: (() => void) | null = null;
  private ws: WebSocket | null = null;
  private stopped = false;
  private hello: CtrlMsg | null = null;
  private epoch = 0;
  private disconnectedAt = 0;
  private attempts = 0;
  private lastInputAt = 0;
  private retry: ReturnType<typeof setTimeout> | undefined;

  static async open(): Promise<SocketLink> {
    const link = new SocketLink(); await link.connect(); return link;
  }
  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/game/ws`);
      this.ws = ws; ws.binaryType = 'arraybuffer';
      const timer = setTimeout(() => { ws.close(); reject(new Error('The server did not answer.')); }, 15000);
      ws.onopen = () => { clearTimeout(timer); this.disconnectedAt = 0; this.attempts = 0; if (this.hello) ws.send(JSON.stringify(this.hello)); resolve(); };
      ws.onmessage = event => {
        if (event.data instanceof ArrayBuffer) {
          if (event.data.byteLength < 5 || new DataView(event.data).getUint32(0, true) !== this.epoch) return;
          this.onFast?.(event.data.slice(4));
        } else {
          const message: CtrlMsg = JSON.parse(event.data);
          if (message.t === 'start') this.epoch = message.epoch ?? 0;
          this.onCtrl?.(message);
        }
      };
      ws.onerror = () => { /* close drives bounded reconnect */ };
      ws.onclose = event => {
        clearTimeout(timer); reject(new Error('Unable to connect to this room.'));
        if (this.stopped) return;
        if (event.code >= 4400 && event.code < 4500) {
          this.onCtrl?.({ t: 'reject', reason: event.code === 4401 ? 'Room opened in another tab.' : event.reason || 'This room is unavailable.' }); this.close(); return;
        }
        this.disconnectedAt ||= performance.now();
        if (!this.hello || performance.now() - this.disconnectedAt >= 30_000) { this.close(); return; }
        this.onCtrl?.({ t: 'notice', reason: 'Connection interrupted. Rejoining your room…' });
        this.retry = setTimeout(() => { void this.connect().catch(() => {}); }, Math.min(8000, 1000 * 2 ** this.attempts++));
      };
    });
  }
  sendCtrl(message: CtrlMsg): void {
    if (message.t === 'hello') this.hello = message;
    if (message.t === 'body' && this.hello?.t === 'hello') this.hello.body = message.body;
    if (this.ws?.readyState === WebSocket.OPEN && this.ws.bufferedAmount <= 64 * 1024) this.ws.send(JSON.stringify(message));
  }
  sendFast(buffer: ArrayBuffer): void {
    if (this.ws?.readyState !== WebSocket.OPEN || this.ws.bufferedAmount > 64 * 1024) return;
    if (new Uint8Array(buffer)[0] === 1) {
      const now = performance.now(); if (now - this.lastInputAt < 1000 / 60) return; this.lastInputAt = now;
    }
    const packet = new Uint8Array(4 + buffer.byteLength);
    new DataView(packet.buffer).setUint32(0, this.epoch, true); packet.set(new Uint8Array(buffer), 4); this.ws.send(packet);
  }
  close(): void {
    if (this.stopped) return; this.stopped = true; clearTimeout(this.retry); this.ws?.close(); this.onClose?.();
  }
}

/** Reuses the existing prediction, rendering, cosmetic sync and controls with a server channel. */
export class ServerRoomSession implements Session {
  readonly kind = 'client';
  private constructor(private readonly client: ClientSession, private readonly link: SocketLink) {}
  static async create(room: RoomAdmission, name: string, dodgeDeadzone: number, body: number): Promise<ServerRoomSession> {
    const link = await SocketLink.open();
    try { return new ServerRoomSession(await ClientSession.createOnLink(link, room.code, name, dodgeDeadzone, body, null, 15000), link); }
    catch (error) { link.close(); throw error; }
  }
  get game() { return this.client.game; }
  get localId() { return this.client.localId; }
  get alpha() { return this.client.alpha; }
  get ping() { return this.client.ping; }
  get lobby() { return this.client.lobby; }
  get stats() { return this.client.stats; }
  get onLobbyChanged() { return this.client.onLobbyChanged; }
  set onLobbyChanged(value) { this.client.onLobbyChanged = value; }
  get onMatchStarted() { return this.client.onMatchStarted; }
  set onMatchStarted(value) { this.client.onMatchStarted = value; }
  get onEnded() { return this.client.onEnded; }
  set onEnded(value) { this.client.onEnded = value; }
  update(input: CarInput, dt: number, menuOpen: boolean) { this.client.update(input, dt, menuOpen); }
  carRenderStates() { return this.client.carRenderStates(); }
  ballOffset(): Vector3 | null { return this.client.ballOffset(); }
  setBody(body: number) { this.client.setBody(body); }
  requestTeam(team: 'blue' | 'orange') { this.client.requestTeam(team); }
  setMatchSeconds(matchSeconds: number) { this.link.sendCtrl({ t: 'settings', matchSeconds }); }
  setArena(arena: number) { if (this.lobby.isHost && !this.lobby.inMatch) this.link.sendCtrl({ t: 'settings', arena }); }
  command(action: 'start' | 'end' | 'reset' | 'close' | 'rotate') { if (this.lobby.isHost) this.link.sendCtrl({ t: 'room-command', action }); }
  resetMatch() { this.command('reset'); }
  leave() { this.client.leave(); }
}
