/**
 * A session is whatever drives the Game the renderer draws: free play, the host of a room, or a
 * client predicting the host's game. main.ts talks only to this interface.
 */
import { Quaternion, Vector3 } from 'three';
import type { Team } from '../sim/car';
import { FREE_PLAY_CONFIG, Game, type BodyState } from '../sim/game';
import { TICK_DT } from '../sim/rl';
import { quantizeInput } from '../sim/state';
import type { CarInput } from '../input/types';
import type { LobbyPlayer, MatchSettings } from './protocol';

/** Where the renderer should draw one car this frame, and what its wheels / flame should do. */
export interface CarRenderState {
  id: number;
  team: Team;
  name: string;
  /** Index into CAR_BODIES. */
  body: number;
  prev: BodyState;
  curr: BodyState;
  alpha: number;
  /** Forward speed (m/s) for wheel spin. */
  forwardSpeed: number;
  /** Steering input in [-1, 1] for the front wheels. */
  steer: number;
  boosting: boolean;
  supersonic: boolean;
  /** Demolished: not drawn at all until it respawns. */
  demoed: boolean;
  /** Visual-only correction that decays after a misprediction (client's own car). */
  offsetPos: Vector3 | null;
  offsetQuat: Quaternion | null;
  /** Local y of each wheel centre (FL, FR, RL, RR) for suspension animation; null = rest pose. */
  wheelY: number[] | null;
}

export interface LobbyState {
  code: string;
  players: LobbyPlayer[];
  mySlot: number;
  isHost: boolean;
  settings: MatchSettings;
  inMatch: boolean;
  /** Human-readable connection status. */
  status: string;
}

export interface Session {
  readonly kind: 'local' | 'host' | 'client';
  /** The game whose ball (and, for host/local, cars) is rendered. Null while a client waits for the match. */
  readonly game: Game | null;
  readonly localId: number;
  /** Interpolation factor between game.prev and game.curr. */
  readonly alpha: number;
  /** Round-trip time in ms, or null when there is no network. */
  readonly ping: number | null;
  /** Lobby information for the menu; null in free play. */
  readonly lobby: LobbyState | null;
  /** Per-frame: read input, step the simulation and/or the network. */
  update(input: CarInput, frameDt: number, menuOpen: boolean): void;
  /** How to draw every car this frame. */
  carRenderStates(): CarRenderState[];
  /** Visual correction for the ball (client only). */
  ballOffset(): Vector3 | null;
  resetMatch(): void;
  leave(): void;
  /** Fired when the lobby or connection state changes (menu refresh). */
  onLobbyChanged: (() => void) | null;
  /** Fired when a match starts (host and clients) so the UI can close the menu. */
  onMatchStarted: (() => void) | null;
  /** Fired when the session ends for good (disconnected, host left). */
  onEnded: ((reason: string) => void) | null;
}

/** Shared: build the render state of a car from a live Car object in a game. */
export function liveCarState(game: Game, id: number, alpha: number, name: string, body = 0): CarRenderState | null {
  const car = game.cars.get(id);
  const prev = game.prev.cars.get(id);
  const curr = game.curr.cars.get(id);
  if (!car || !prev || !curr) return null;
  const lv = car.body.linvel();
  const q = curr;
  const fwdX = -(2 * (q.qx * q.qz + q.qw * q.qy));
  const fwdZ = -(1 - 2 * (q.qx * q.qx + q.qy * q.qy));
  return {
    id,
    team: car.team,
    name,
    body,
    prev,
    curr,
    alpha,
    forwardSpeed: lv.x * fwdX + lv.z * fwdZ,
    steer: car.lastInput.steer,
    boosting: car.boosting,
    supersonic: car.supersonic,
    demoed: car.demoed,
    offsetPos: null,
    offsetQuat: null,
    wheelY: car.wheelCenterY([0, 0, 0, 0]),
  };
}

/** Free play: one car, the game stepped right here. */
export class LocalSession implements Session {
  readonly kind = 'local';
  readonly localId = 0;
  readonly ping = null;
  readonly lobby = null;
  alpha = 0;
  onLobbyChanged: (() => void) | null = null;
  onMatchStarted: (() => void) | null = null;
  onEnded: ((reason: string) => void) | null = null;
  /** Chosen car body, set from the player's settings. */
  body = 0;
  private accumulator = 0;

  constructor(readonly game: Game) {
    game.addCar(0, 'blue');
  }

  static async create(): Promise<LocalSession> {
    return new LocalSession(await Game.create(FREE_PLAY_CONFIG));
  }

  update(input: CarInput, frameDt: number, menuOpen: boolean): void {
    if (menuOpen) return; // free play pauses behind the menu
    const q = quantizeInput(input);
    this.accumulator += frameDt;
    let steps = 0;
    while (this.accumulator >= TICK_DT && steps < 12) {
      this.game.step(q, TICK_DT);
      this.accumulator -= TICK_DT;
      steps++;
    }
    if (steps === 12) this.accumulator = 0; // tab was hidden or the machine stalled; drop the backlog
    this.alpha = Math.min(1, this.accumulator / TICK_DT);
  }

  carRenderStates(): CarRenderState[] {
    const s = liveCarState(this.game, 0, this.alpha, '', this.body);
    return s ? [s] : [];
  }

  ballOffset(): Vector3 | null {
    return null;
  }

  resetMatch(): void {
    this.game.resetMatch();
  }

  leave(): void {
    this.game.destroy();
  }

  /** Resync the accumulator after the menu closes so the backlog is not simulated at once. */
  resume(): void {
    this.accumulator = 0;
  }
}
