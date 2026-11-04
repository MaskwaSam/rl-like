import type { CtrlMsg } from '../src/net/protocol';
import type { GameLink } from '../src/net/channel';
import type { Peer } from 'peerjs';
import { SpectatorSession } from '../src/net/spectator';

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`FAIL ${message}`);
  console.log(`PASS ${message}`);
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

class FakeLink {
  onCtrl: ((msg: CtrlMsg) => void) | null = null;
  onFast: ((buf: ArrayBuffer) => void) | null = null;
  onClose: (() => void) | null = null;
  closed = false;
  sends = 0;
  constructor(private readonly throwOnSend = false) {}
  sendCtrl(): void {
    this.sends++;
    if (this.throwOnSend) throw new Error('send failed');
  }
  sendFast(): void {}
  close(): void { if (this.closed) return; this.closed = true; this.onClose?.(); }
  closeWithError(): void { this.onClose?.(); }
}
class FakePeer {
  listeners = new Map<string, (err: Error) => void>();
  destroyed = false;
  on(event: string, cb: (err: Error) => void): this { this.listeners.set(event, cb); return this; }
  destroy(): void { this.destroyed = true; }
}
const asLink = (link: FakeLink) => link as unknown as GameLink;
const asPeer = (peer: FakePeer) => peer as unknown as Peer;

{
  const link = new FakeLink(), peer = new FakePeer();
  const started = Date.now();
  const pending = SpectatorSession.createOnLink(asLink(link), 'WELCOME', asPeer(peer), 250);
  link.onCtrl?.({ t: 'welcome' });
  const result = await pending;
  check(result.status.startsWith('Watching'), 'welcome resolves admission');
  await delay(300);
  check(Date.now() - started >= 250 && !link.closed && !peer.destroyed, 'success clears timeout and preserves live resources');
}
for (const terminal of ['close', 'error'] as const) {
  const link = new FakeLink(), peer = new FakePeer();
  const pending = SpectatorSession.createOnLink(asLink(link), terminal, asPeer(peer), 1000);
  if (terminal === 'close') link.closeWithError();
  else peer.listeners.get('error')?.(Object.assign(new Error('network reset'), { type: 'network-reset' }));
  const err = await pending.then(() => null, e => e as Error);
  check(err?.message === (terminal === 'close' ? 'Disconnected from the host' : 'Connection error: network reset'), `${terminal} before welcome rejects promptly with its reason`);
  check(link.closed && peer.destroyed, `${terminal} before welcome cleans link and peer`);
  link.onCtrl?.({ t: 'welcome' });
  check(link.closed, `late welcome after ${terminal} does not resurrect session`);
}
{
  const link = new FakeLink();
  const pending = SpectatorSession.createOnLink(asLink(link), 'REJECT', null, 1000);
  link.onCtrl?.({ t: 'reject', reason: 'Room is full' });
  const err = await pending.then(() => null, e => e as Error);
  check(err?.message === 'Room is full', 'explicit rejection keeps the host reason');
}
{
  const link = new FakeLink();
  const err = await SpectatorSession.createOnLink(asLink(link), 'TIMEOUT', null, 10).then(() => null, e => e as Error);
  check(err?.message === 'The host did not answer. It may need to reload to the latest version to allow spectators.', 'silent host retains the timeout message');
  check(link.closed, 'timeout cleans the link');
}
{
  const link = new FakeLink(true), peer = new FakePeer();
  const err = await SpectatorSession.createOnLink(asLink(link), 'SEND', asPeer(peer), 1000).then(() => null, e => e as Error);
  check(err?.message === 'Connection error: send failed', 'synchronous send failure rejects with its cause');
  check(link.closed && peer.destroyed, 'synchronous send failure cleans link and peer');
}
