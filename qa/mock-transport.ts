/** Headless-only in-memory links. Never imported by the production app or browser QA page. */
import type { CtrlMsg } from '../src/net/protocol';

export class Link {
  onCtrl: ((msg: CtrlMsg) => void) | null = null;
  onFast: ((buf: ArrayBuffer) => void) | null = null;
  onClose: (() => void) | null = null;
  other!: Link;
  closed = false;
  sendCtrl(msg: CtrlMsg): void {
    const packet = structuredClone(msg);
    queueMicrotask(() => { if (!this.closed && !this.other.closed) this.other.onCtrl?.(packet); });
  }
  sendFast(buf: ArrayBuffer): void {
    const packet = buf.slice(0);
    queueMicrotask(() => { if (!this.closed && !this.other.closed) this.other.onFast?.(packet); });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.other.closed = true;
    this.onClose?.(); this.other.onClose?.();
  }
}

class TestPeer {
  onLink: ((link: Link) => void) | null = null;
  constructor(readonly code = '') {}
  on(): this { return this; }
  reconnect(): void {}
  destroy(): void { if (this.code) rooms.delete(this.code); }
}

const rooms = new Map<string, TestPeer>();
let nextRoom = 0;
export async function hostRoom(): Promise<{ peer: TestPeer; code: string }> {
  const code = `TEST${++nextRoom}`;
  const peer = new TestPeer(code); rooms.set(code, peer);
  return { peer, code };
}
export function acceptConnections(peer: TestPeer, onLink: (link: Link) => void): void { peer.onLink = onLink; }
export async function joinRoom(code: string): Promise<{ peer: TestPeer; link: Link }> {
  const host = rooms.get(code);
  if (!host?.onLink) throw new Error('No test host');
  const clientLink = new Link(), hostLink = new Link();
  clientLink.other = hostLink; hostLink.other = clientLink;
  host.onLink(hostLink);
  return { peer: new TestPeer(), link: clientLink };
}
