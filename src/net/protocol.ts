/**
 * Wire protocol between the host tab and its clients.
 *
 * Control messages are JSON on the reliable, ordered channel: lobby, start, end.
 * Game packets are binary on the unreliable channel (falling back to the reliable one):
 * inputs from clients, snapshots from the host, and a ping/pong pair for latency.
 */
import type { Team } from '../sim/car';
import type { GameConfig } from '../sim/game';
import type { CarInput } from '../input/types';
import { ByteReader, ByteWriter, readInput, writeInput } from '../sim/state';

export const PROTOCOL_VERSION = 2;
export const MAX_PLAYERS = 8;
/** Car bodies to choose from; must match CAR_BODIES in render/cars.ts. Cosmetic only. */
export const CAR_BODY_COUNT = 3;

export function clampBody(body: unknown): number {
  return typeof body === 'number' && Number.isInteger(body) && body >= 0 && body < CAR_BODY_COUNT ? body : 0;
}

export interface LobbyPlayer {
  slot: number;
  name: string;
  team: Team;
  /** Index into CAR_BODIES. */
  body: number;
}

export interface MatchSettings {
  /** 0 = unlimited. */
  matchSeconds: number;
}

export const DEFAULT_MATCH_SETTINGS: MatchSettings = { matchSeconds: 300 };

export type CtrlMsg =
  | { t: 'hello'; name: string; version: number; dodgeDeadzone: number; body: number }
  | { t: 'welcome'; slot: number }
  | { t: 'reject'; reason: string }
  /** Host is ready to receive the unreliable channel; the client creates it on receipt. */
  | { t: 'fastready' }
  | { t: 'lobby'; players: LobbyPlayer[]; settings: MatchSettings; inMatch: boolean }
  | { t: 'team'; team: Team }
  | { t: 'body'; body: number }
  | { t: 'start'; config: GameConfig }
  | { t: 'end' };

export const enum Packet {
  Input = 1,
  Snapshot = 2,
  Ping = 3,
  Pong = 4,
}

/** Client -> host: inputs for consecutive ticks starting at firstTick (most recent last). */
export function encodeInputs(firstTick: number, inputs: CarInput[]): ArrayBuffer {
  const w = new ByteWriter(8 + inputs.length * 6);
  w.u8(Packet.Input);
  w.u32(firstTick);
  w.u8(inputs.length);
  for (const i of inputs) writeInput(w, i);
  return w.finish();
}

export function decodeInputs(r: ByteReader): { firstTick: number; inputs: CarInput[] } {
  const firstTick = r.u32();
  const n = r.u8();
  const inputs: CarInput[] = [];
  for (let i = 0; i < n; i++) inputs.push(readInput(r));
  return { firstTick, inputs };
}

/**
 * Host -> client: header then the serialised game. `lastInputTick` is the newest input tick the
 * host has received from this client, so the client can tell how far ahead it should run.
 */
export function encodeSnapshot(state: ArrayBuffer, lastInputTick: number, hostTimeMs: number): ArrayBuffer {
  const out = new ArrayBuffer(1 + 4 + 4 + state.byteLength);
  const view = new DataView(out);
  view.setUint8(0, Packet.Snapshot);
  view.setInt32(1, lastInputTick, true);
  view.setUint32(5, hostTimeMs >>> 0, true);
  new Uint8Array(out, 9).set(new Uint8Array(state));
  return out;
}

export function encodePing(sentMs: number): ArrayBuffer {
  const w = new ByteWriter(5);
  w.u8(Packet.Ping);
  w.u32(sentMs >>> 0);
  return w.finish();
}

export function encodePong(sentMs: number): ArrayBuffer {
  const w = new ByteWriter(5);
  w.u8(Packet.Pong);
  w.u32(sentMs >>> 0);
  return w.finish();
}
