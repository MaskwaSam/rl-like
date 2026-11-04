import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

// Real worker/IPC with deliberately withheld output ACKs. No WebSocket or
// renderer mocks can accidentally make a slow reader block the authority.
const worker = new Worker(new URL('../.server-build/worker.js', import.meta.url), {
  workerData: { owner: 'owner', teamSize: 1, snapshotHz: 60 },
});
const events = [];
let failure;
let checks = 0;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const post = (principal, connectionId, message, transfer = []) =>
  worker.postMessage({ ...message, principal, connectionId }, transfer);
const ack = event => post(event.principal, event.connectionId, { type: 'delivered' });
const snapshots = (principal, connectionId) => events.filter(event => event.type === 'binary'
  && event.principal === principal && event.connectionId === connectionId && new Uint8Array(event.buffer)[0] === 2);
const tick = event => new DataView(event.buffer).getUint32(9, true);
const check = (value, description) => { assert.ok(value, description); checks++; console.log(`PASS ${description}`); };
async function wait(predicate, description) {
  const deadline = performance.now() + 8000;
  while (!predicate()) {
    if (failure) throw failure;
    if (performance.now() > deadline) throw new Error(`Timed out: ${description}`);
    await delay(5);
  }
}
worker.on('error', error => { failure = error; });
worker.on('message', event => {
  events.push(event);
  // Controls flow normally; binary output is held until the test releases it.
  if (event.type === 'ctrl') ack(event);
});
const hello = name => ({ t: 'hello', name, version: 3, body: 0, dodgeDeadzone: 0.5 });

try {
  post('owner', 'o1', { type: 'admit', message: hello('Owner') });
  post('guest', 'g1', { type: 'admit', message: hello('Guest') });
  await wait(() => events.filter(e => e.type === 'ctrl' && e.message.t === 'welcome').length === 2, 'admission');
  post('owner', 'o1', { type: 'control', message: { t: 'room-command', action: 'start' } });
  await wait(() => snapshots('owner', 'o1').length && snapshots('guest', 'g1').length, 'first snapshots');
  const first = snapshots('owner', 'o1')[0];
  await delay(180);
  check(snapshots('owner', 'o1').length === 1 && snapshots('guest', 'g1').length === 1,
    'blocked readers each retain only one in-flight binary');

  const marker = events.length;
  post('owner', 'o1', { type: 'control', message: { t: 'body', body: 2 } });
  await wait(() => events.slice(marker).some(e => e.type === 'processed' && e.principal === 'owner'), 'queued control');
  const release = events.length;
  ack(first);
  await wait(() => snapshots('owner', 'o1').length === 2, 'coalesced snapshot');
  const output = events.slice(release).filter(e => e.principal === 'owner' && (e.type === 'ctrl' || e.type === 'binary'));
  check(output[0]?.type === 'ctrl' && output[0].message.t === 'lobby', 'control delivery precedes a queued snapshot');
  const latest = snapshots('owner', 'o1')[1];
  check(tick(latest) >= tick(first) + 10, 'physics continues while both readers are blocked and output resumes at a recent tick');
  check(snapshots('guest', 'g1').length === 1, 'releasing one reader does not release the other queue');

  // Model the owned copy made from a potentially pooled ws Buffer, then move
  // that allocation across the actual worker boundary. Never transfer the pool.
  const storage = Buffer.allocUnsafe(128).fill(0xa5);
  const wire = storage.subarray(16, 32);
  wire.writeUInt32LE(latest.epoch, 0);
  wire[4] = 1;
  const inputTick = tick(latest) + 120;
  wire.writeUInt32LE(inputTick, 5);
  wire[9] = 1;
  wire.fill(0, 10); wire[10] = 127;
  const saved = Buffer.from(storage);
  const payload = Uint8Array.from(wire.subarray(4)).buffer;
  const inputMarker = events.length;
  post('owner', 'o1', { type: 'binary', epoch: latest.epoch, buffer: payload }, [payload]);
  check(payload.byteLength === 0, 'input payload ownership transfers instead of being cloned');
  check(storage.equals(saved), 'transferring the owned payload leaves pooled source bytes intact');
  await wait(() => events.slice(inputMarker).some(e => e.type === 'processed' && e.principal === 'owner'), 'transferred input');
  await delay(30);
  ack(latest);
  await wait(() => snapshots('owner', 'o1').length === 3, 'input acknowledgement snapshot');
  const accepted = snapshots('owner', 'o1')[2];
  check(new DataView(accepted.buffer).getInt32(1, true) === inputTick, 'worker decodes transferred input and returns the correct acknowledgement');

  // Replacing the same principal fences outstanding output and inbound work.
  post('owner', 'o2', { type: 'admit', message: hello('Replacement') });
  await wait(() => snapshots('owner', 'o2').length === 1, 'replacement snapshot');
  ack(accepted);
  post('owner', 'o1', { type: 'binary', epoch: latest.epoch + 100, buffer: new ArrayBuffer(0) });
  await delay(80);
  check(snapshots('owner', 'o2').length === 1, 'a stale delivery ACK cannot unblock the replacement connection');
  check(!events.some(e => e.type === 'invalid'), 'stale input cannot invalidate the replacement connection');
  ack(snapshots('owner', 'o2')[0]);
  await wait(() => snapshots('owner', 'o2').length === 2, 'replacement progress');
  check(true, 'replacement resumes with its own delivery ACK');
  console.log(`${checks} dedicated server worker queue checks passed`);
} finally {
  await worker.terminate();
}
