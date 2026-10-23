import { parentPort, workerData } from 'node:worker_threads';
import { RoomAuthority } from './authority';
import type { CtrlMsg } from '../src/net/protocol';

const port = parentPort!;
interface Outbox { connectionId: string; busy: boolean; controls: CtrlMsg[]; snapshot?: { epoch: number; buffer: ArrayBuffer }; stopped: boolean }
const outboxes = new Map<string, Outbox>();
function pump(principal: string): void {
  const box = outboxes.get(principal);
  if (!box || box.busy || box.stopped) return;
  const message = box.controls.shift();
  if (message) { box.busy = true; port.postMessage({ type: 'ctrl', principal, connectionId: box.connectionId, message }); }
  else if (box.snapshot) {
    const { epoch, buffer } = box.snapshot; box.snapshot = undefined; box.busy = true;
    port.postMessage({ type: 'binary', principal, connectionId: box.connectionId, epoch, buffer }, [buffer]);
  }
}
const authority = new RoomAuthority(workerData.owner, workerData.teamSize,
  (principal, message) => {
    const box = outboxes.get(principal);
    if (!box || box.stopped) return;
    if (box.controls.length >= 16) { box.stopped = true; port.postMessage({ type: 'invalid', principal, connectionId: box.connectionId }); return; }
    box.controls.push(message); pump(principal);
  },
  (principal, epoch, buffer) => { const box = outboxes.get(principal); if (!box) return; box.snapshot = { epoch, buffer }; pump(principal); }, workerData.snapshotHz);
port.on('message', message => {
  if (message.type === 'delivered') {
    const box = outboxes.get(message.principal);
    if (box && box.connectionId === message.connectionId) { box.busy = false; pump(message.principal); }
    return;
  }
  if (message.type === 'admit') {
    // Replacing a tab also replaces its output queue. Late packets/ACKs from
    // the previous connection cannot admit, close or unblock the new tab.
    outboxes.set(message.principal, { connectionId: message.connectionId, busy: false, controls: [], stopped: false });
    if (!authority.admit(message.principal, message.message)) port.postMessage({ type: 'invalid', principal: message.principal, connectionId: message.connectionId });
  } else if (message.type === 'remove') {
    outboxes.delete(message.principal); authority.remove(message.principal);
  } else if (message.type === 'refresh') authority.refresh();
  else {
    if (outboxes.get(message.principal)?.connectionId !== message.connectionId) return;
    if (message.type === 'control') {
      if (!authority.control(message.principal, message.message)) port.postMessage({ type: 'invalid', principal: message.principal, connectionId: message.connectionId });
    } else if (message.type === 'binary') {
      if (!authority.packet(message.principal, message.epoch, message.buffer)) port.postMessage({ type: 'invalid', principal: message.principal, connectionId: message.connectionId });
    } else if (message.type === 'disconnect') { outboxes.delete(message.principal); authority.disconnect(message.principal); }
  }
  if (message.connectionId) port.postMessage({ type: 'processed', principal: message.principal, connectionId: message.connectionId });
});
let last = performance.now();
setInterval(() => { const now = performance.now(); authority.advance((now - last) / 1000); last = now; }, 4);
setInterval(() => port.postMessage({ type: 'metrics', metrics: authority.metrics }), 5_000).unref();
