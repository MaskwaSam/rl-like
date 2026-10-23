/**
 * Binary state helpers shared by the simulation and the network layer: a growable byte writer,
 * a matching reader, input quantisation (so the local prediction and the host apply the very
 * same numbers), and a seeded RNG so a client can reproduce the host's kickoff shuffles.
 */
import type { CarInput } from '../input/types';

export class ByteWriter {
  private buf: ArrayBuffer;
  private view: DataView;
  private bytes: Uint8Array;
  offset = 0;

  constructor(capacity = 1024) {
    this.buf = new ArrayBuffer(capacity);
    this.view = new DataView(this.buf);
    this.bytes = new Uint8Array(this.buf);
  }

  private ensure(n: number): void {
    if (this.offset + n <= this.buf.byteLength) return;
    let cap = this.buf.byteLength * 2;
    while (cap < this.offset + n) cap *= 2;
    const next = new ArrayBuffer(cap);
    new Uint8Array(next).set(this.bytes.subarray(0, this.offset));
    this.buf = next;
    this.view = new DataView(next);
    this.bytes = new Uint8Array(next);
  }

  u8(v: number): void {
    this.ensure(1);
    this.view.setUint8(this.offset, v);
    this.offset += 1;
  }
  i8(v: number): void {
    this.ensure(1);
    this.view.setInt8(this.offset, v);
    this.offset += 1;
  }
  u16(v: number): void {
    this.ensure(2);
    this.view.setUint16(this.offset, v, true);
    this.offset += 2;
  }
  i32(v: number): void {
    this.ensure(4);
    this.view.setInt32(this.offset, v, true);
    this.offset += 4;
  }
  u32(v: number): void {
    this.ensure(4);
    this.view.setUint32(this.offset, v >>> 0, true);
    this.offset += 4;
  }
  f32(v: number): void {
    this.ensure(4);
    this.view.setFloat32(this.offset, v, true);
    this.offset += 4;
  }
  bool(v: boolean): void {
    this.u8(v ? 1 : 0);
  }
  string(s: string): void {
    const enc = new TextEncoder().encode(s);
    this.u16(enc.length);
    this.ensure(enc.length);
    this.bytes.set(enc, this.offset);
    this.offset += enc.length;
  }

  /** A copy of the bytes written so far. */
  finish(): ArrayBuffer {
    return this.buf.slice(0, this.offset);
  }
}

export class ByteReader {
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  offset = 0;

  constructor(buf: ArrayBuffer, byteOffset = 0, byteLength?: number) {
    this.view = new DataView(buf, byteOffset, byteLength);
    this.bytes = new Uint8Array(buf, byteOffset, byteLength);
  }

  get remaining(): number {
    return this.view.byteLength - this.offset;
  }

  u8(): number {
    const v = this.view.getUint8(this.offset);
    this.offset += 1;
    return v;
  }
  i8(): number {
    const v = this.view.getInt8(this.offset);
    this.offset += 1;
    return v;
  }
  u16(): number {
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }
  i32(): number {
    const v = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return v;
  }
  u32(): number {
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }
  f32(): number {
    const v = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return v;
  }
  bool(): boolean {
    return this.u8() !== 0;
  }
  string(): string {
    const n = this.u16();
    const s = new TextDecoder().decode(this.bytes.subarray(this.offset, this.offset + n));
    this.offset += n;
    return s;
  }
}

// -----------------------------------------------------------------------------
// Input quantisation: 5 signed bytes for the axes, one flag byte. 6 bytes per tick.
// -----------------------------------------------------------------------------

const AXIS_SCALE = 127;

function qAxis(v: number): number {
  return Math.max(-AXIS_SCALE, Math.min(AXIS_SCALE, Math.round(v * AXIS_SCALE)));
}

/** Round the analog axes to the wire precision so prediction and authority see identical inputs. */
export function quantizeInput(i: CarInput): CarInput {
  return {
    throttle: qAxis(i.throttle) / AXIS_SCALE,
    steer: qAxis(i.steer) / AXIS_SCALE,
    pitch: qAxis(i.pitch) / AXIS_SCALE,
    yaw: qAxis(i.yaw) / AXIS_SCALE,
    roll: qAxis(i.roll) / AXIS_SCALE,
    jump: i.jump,
    boost: i.boost,
    handbrake: i.handbrake,
    airRoll: i.airRoll,
  };
}

export const INPUT_BYTES = 6;

export function writeInput(w: ByteWriter, i: CarInput): void {
  w.i8(qAxis(i.throttle));
  w.i8(qAxis(i.steer));
  w.i8(qAxis(i.pitch));
  w.i8(qAxis(i.yaw));
  w.i8(qAxis(i.roll));
  w.u8((i.jump ? 1 : 0) | (i.boost ? 2 : 0) | (i.handbrake ? 4 : 0) | (i.airRoll ? 8 : 0));
}

export function readInput(r: ByteReader): CarInput {
  const throttle = r.i8() / AXIS_SCALE;
  const steer = r.i8() / AXIS_SCALE;
  const pitch = r.i8() / AXIS_SCALE;
  const yaw = r.i8() / AXIS_SCALE;
  const roll = r.i8() / AXIS_SCALE;
  const f = r.u8();
  return { throttle, steer, pitch, yaw, roll, jump: !!(f & 1), boost: !!(f & 2), handbrake: !!(f & 4), airRoll: !!(f & 8) };
}

export function inputsEqual(a: CarInput, b: CarInput): boolean {
  return (
    a.throttle === b.throttle &&
    a.steer === b.steer &&
    a.pitch === b.pitch &&
    a.yaw === b.yaw &&
    a.roll === b.roll &&
    a.jump === b.jump &&
    a.boost === b.boost &&
    a.handbrake === b.handbrake &&
    a.airRoll === b.airRoll
  );
}

// -----------------------------------------------------------------------------
// Seeded RNG (xorshift32). The state is part of the serialised game so a restored client
// draws the same kickoff order as the host.
// -----------------------------------------------------------------------------

export class Rng {
  constructor(public state: number = 0x9e3779b9) {
    if (this.state === 0) this.state = 0x9e3779b9;
  }

  /** Uniform in [0, 1). */
  next(): number {
    let x = this.state | 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x | 0;
    return (x >>> 0) / 4294967296;
  }
}
