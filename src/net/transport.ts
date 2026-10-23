/**
 * WebRTC transport on top of PeerJS. PeerJS does the signalling (its free public broker) and
 * gives us one reliable, ordered data channel per peer. For game traffic we open a second
 * channel on the same connection, unordered with no retransmits, so a lost packet never holds
 * up the ones behind it. If that channel is not available, game packets ride the reliable one.
 *
 * ICE: we pass our own server list rather than PeerJS's defaults. Two peers only connect without
 * a relay when one of them is directly reachable; between two home routers, or between two
 * browser profiles behind the same router that does not hairpin NAT, the only path is a TURN
 * relay. PeerJS's built-in relay is a single host and is frequently unavailable, which shows up
 * as "timed out connecting" after signalling has already succeeded, so we list several relays
 * over UDP, TCP and TLS/443 (the last gets through restrictive networks) and let ICE choose.
 */
import { Peer, type DataConnection } from 'peerjs';
import type { CtrlMsg } from './protocol';

/**
 * STUN servers tell each peer its public address. These are enough when at least one side's
 * router lets an inbound connection through; when neither does (symmetric NAT, carrier-grade
 * NAT, most mobile networks, and two profiles behind a router that will not hairpin) the only
 * path is a TURN relay, which must be configured separately: see `loadIceConfig`.
 *
 * PeerJS's own defaults are deliberately not used. Its relay hosts (eu-0/us-0.turn.peerjs.com)
 * no longer resolve in DNS, so relying on them meant every connection that needed a relay
 * failed after signalling had already succeeded.
 */
const STUN_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

/** Relay servers loaded at runtime from `turn.json`, so credentials can change without a rebuild. */
let turnServers: RTCIceServer[] = [];

export function iceServers(): RTCIceServer[] {
  return [...STUN_SERVERS, ...turnServers];
}

/** True once a relay is configured; without one, players on different networks often cannot connect. */
export function turnConfigured(): boolean {
  return turnServers.length > 0;
}

/**
 * Load relay credentials from `public/turn.json`, which is deployed with the site and read at
 * startup. Two shapes are accepted:
 *
 *   { "iceServers": [ { "urls": "turn:host:3478", "username": "u", "credential": "c" } ] }
 *   { "credentialsUrl": "https://<app>.metered.live/api/v1/turn/credentials?apiKey=..." }
 *
 * The second fetches short-lived credentials from the provider on each load. A missing or
 * unreadable file is not an error: the game still runs, and connections that need a relay fail
 * with an explanation instead.
 */
export async function loadIceConfig(): Promise<void> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}turn.json`, { cache: 'no-store' });
    if (!res.ok) return;
    const cfg = (await res.json()) as { iceServers?: RTCIceServer[]; credentialsUrl?: string };
    if (Array.isArray(cfg.iceServers) && cfg.iceServers.length > 0) {
      turnServers = cfg.iceServers;
      return;
    }
    if (cfg.credentialsUrl) {
      const r = await fetch(cfg.credentialsUrl, { cache: 'no-store' });
      if (!r.ok) return;
      const list = (await r.json()) as RTCIceServer[];
      if (Array.isArray(list)) turnServers = list;
    }
  } catch {
    /* no relay configured; STUN only */
  }
}

/**
 * `?relay=1` forces every connection through the TURN relay, skipping direct paths. That is the
 * situation two players on different home networks are in, so it makes their case reproducible
 * from one machine.
 */
export function relayForced(): boolean {
  try {
    return new URLSearchParams(location.search).get('relay') === '1';
  } catch {
    return false;
  }
}

function peerOptions() {
  const config: RTCConfiguration = { iceServers: iceServers(), iceCandidatePoolSize: 2 };
  if (relayForced()) config.iceTransportPolicy = 'relay';
  return { debug: 1, config };
}

/**
 * What ICE managed to gather and where a connection got to. Kept for the UI so a failure can say
 * which part broke instead of only "timed out".
 */
export interface NetDiagnostics {
  /** Candidate types seen locally: `host` (same machine/LAN), `srflx` (via STUN), `relay` (via TURN). */
  candidateTypes: string[];
  /** Reachable TURN servers, by URL. */
  relayServers: string[];
  /** ICE errors, e.g. a TURN server refusing the allocation. */
  errors: string[];
  iceState: string;
  connectionState: string;
  /** The pair ICE settled on, once connected. */
  selectedPair: string | null;
}

function emptyDiagnostics(): NetDiagnostics {
  return { candidateTypes: [], relayServers: [], errors: [], iceState: 'new', connectionState: 'new', selectedPair: null };
}

/** The most recent connection attempt's diagnostics, for the menu and the console. */
export let lastDiagnostics: NetDiagnostics = emptyDiagnostics();

/** Watch a peer connection and record what ICE finds, so failures can be explained. */
function observe(pc: RTCPeerConnection, diag: NetDiagnostics): void {
  pc.addEventListener('icecandidate', (e) => {
    const c = e.candidate;
    if (!c || !c.candidate) return;
    const type = c.type ?? 'unknown';
    if (!diag.candidateTypes.includes(type)) diag.candidateTypes.push(type);
    // `url` (which TURN server produced this) is in the spec but missing from the DOM types.
    const url = (c as RTCIceCandidate & { url?: string }).url;
    if (type === 'relay' && url && !diag.relayServers.includes(url)) diag.relayServers.push(url);
  });
  pc.addEventListener('icecandidateerror', (e) => {
    const ev = e as RTCPeerConnectionIceErrorEvent;
    // 701 just means one server of several did not answer; only note it once per server.
    const msg = `${ev.errorCode} ${ev.errorText ?? ''} ${ev.url ?? ''}`.trim();
    if (diag.errors.length < 6 && !diag.errors.includes(msg)) diag.errors.push(msg);
  });
  pc.addEventListener('iceconnectionstatechange', () => {
    diag.iceState = pc.iceConnectionState;
  });
  pc.addEventListener('connectionstatechange', () => {
    diag.connectionState = pc.connectionState;
    if (pc.connectionState === 'connected') {
      void pc
        .getStats()
        .then((stats) => {
          stats.forEach((r) => {
            if (r.type === 'candidate-pair' && (r as RTCIceCandidatePairStats).state === 'succeeded') {
              const local = stats.get((r as RTCIceCandidatePairStats).localCandidateId ?? '') as { candidateType?: string } | undefined;
              const remote = stats.get((r as RTCIceCandidatePairStats).remoteCandidateId ?? '') as { candidateType?: string } | undefined;
              if (local && remote) diag.selectedPair = `${local.candidateType} -> ${remote.candidateType}`;
            }
          });
        })
        .catch(() => {});
    }
  });
}

/**
 * Gather ICE candidates with no peer on the other end, to see what this network allows.
 * `relayOnly` proves whether a TURN relay is usable, which is what decides whether two people
 * on different networks can play at all.
 */
export function testConnectivity(relayOnly = false, timeoutMs = 8000): Promise<NetDiagnostics> {
  return new Promise((resolve) => {
    const diag = emptyDiagnostics();
    let pc: RTCPeerConnection;
    try {
      pc = new RTCPeerConnection({ iceServers: iceServers(), iceTransportPolicy: relayOnly ? 'relay' : 'all' });
    } catch (err) {
      diag.errors.push(String(err));
      resolve(diag);
      return;
    }
    observe(pc, diag);
    pc.createDataChannel('probe');
    void pc
      .createOffer()
      .then((o) => pc.setLocalDescription(o))
      .catch((err) => diag.errors.push(String(err)));
    const finish = () => {
      diag.iceState = pc.iceGatheringState;
      try {
        pc.close();
      } catch {
        /* ignore */
      }
      resolve(diag);
    };
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') finish();
    });
    setTimeout(finish, timeoutMs);
  });
}

const ID_PREFIX = 'rl-like-v1-';
/** Unambiguous room-code alphabet: no 0/O, 1/I. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function randomCode(length = 5): string {
  let s = '';
  for (let i = 0; i < length; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}

export function normalizeCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function peerIdForCode(code: string): string {
  return ID_PREFIX + normalizeCode(code);
}

/** One connection to a remote peer: a reliable JSON channel and (once set up) a fast binary one. */
export class Link {
  onCtrl: ((msg: CtrlMsg) => void) | null = null;
  onFast: ((buf: ArrayBuffer) => void) | null = null;
  onClose: (() => void) | null = null;
  closed = false;
  private fast: RTCDataChannel | null = null;

  constructor(
    readonly conn: DataConnection,
    /** The host side receives the fast channel; the client side creates it. */
    private readonly hostSide: boolean,
  ) {
    conn.on('data', (data: unknown) => {
      if (typeof data === 'string') {
        let msg: CtrlMsg;
        try {
          msg = JSON.parse(data) as CtrlMsg;
        } catch {
          return;
        }
        if (msg.t === 'fastready' && !this.hostSide) {
          this.createFastChannel();
          return;
        }
        this.onCtrl?.(msg);
      } else if (data instanceof ArrayBuffer) {
        this.onFast?.(data);
      } else if (ArrayBuffer.isView(data)) {
        const v = data as ArrayBufferView;
        this.onFast?.(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer);
      }
    });
    conn.on('close', () => this.handleClose());
    conn.on('error', () => this.handleClose());
    conn.on('iceStateChanged', (state) => {
      if (state === 'failed' || state === 'closed' || state === 'disconnected') this.handleClose();
    });
  }

  /** Call once the reliable channel is open. Host side: listen for the fast channel and invite it. */
  start(): void {
    if (this.hostSide) {
      const pc = this.conn.peerConnection;
      if (pc) {
        // PeerJS would otherwise adopt any new channel as its own; from here on new channels are ours.
        pc.ondatachannel = (evt) => {
          if (evt.channel.label === 'fast') this.adoptFast(evt.channel);
        };
        this.sendCtrl({ t: 'fastready' });
      }
    }
  }

  get fastOpen(): boolean {
    return this.fast !== null && this.fast.readyState === 'open';
  }

  private createFastChannel(): void {
    const pc = this.conn.peerConnection;
    if (!pc || this.fast) return;
    try {
      const ch = pc.createDataChannel('fast', { ordered: false, maxRetransmits: 0 });
      this.adoptFast(ch);
    } catch {
      /* stay on the reliable channel */
    }
  }

  private adoptFast(ch: RTCDataChannel): void {
    ch.binaryType = 'arraybuffer';
    ch.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) this.onFast?.(e.data);
    };
    ch.onclose = () => {
      if (this.fast === ch) this.fast = null;
    };
    ch.onerror = () => {
      if (this.fast === ch) this.fast = null;
    };
    this.fast = ch;
  }

  sendCtrl(msg: CtrlMsg): void {
    if (this.closed || !this.conn.open) return;
    try {
      this.conn.send(JSON.stringify(msg));
    } catch {
      /* dropped */
    }
  }

  sendFast(buf: ArrayBuffer): void {
    if (this.closed) return;
    if (this.fast && this.fast.readyState === 'open') {
      // Do not queue behind a stalled link: game packets are only useful fresh.
      if (this.fast.bufferedAmount > 64 * 1024) return;
      try {
        this.fast.send(buf);
        return;
      } catch {
        /* fall through */
      }
    }
    if (this.conn.open) {
      try {
        this.conn.send(buf);
      } catch {
        /* dropped */
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.fast?.close();
    } catch {
      /* ignore */
    }
    try {
      this.conn.close();
    } catch {
      /* ignore */
    }
    this.onClose?.();
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.();
  }
}

function openPeer(id?: string): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const opts = peerOptions();
    const peer = id ? new Peer(id, opts) : new Peer(opts);
    const onError = (err: Error & { type?: string }) => {
      peer.destroy();
      reject(err);
    };
    peer.once('open', () => {
      peer.off('error', onError);
      resolve(peer);
    });
    peer.once('error', onError);
  });
}

/** Register a room with the signalling server. Retries with a fresh code if one is taken. */
export async function hostRoom(): Promise<{ peer: Peer; code: string }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    try {
      const peer = await openPeer(peerIdForCode(code));
      return { peer, code };
    } catch (err) {
      const type = (err as { type?: string }).type;
      if (type !== 'unavailable-id') throw err;
    }
  }
  throw new Error('Could not find a free room code');
}

/**
 * Connect to a room. Resolves once the reliable channel is open. A timeout here means signalling
 * worked (the room exists) but no network path could be found, so the message says that rather
 * than blaming the code.
 */
export async function joinRoom(code: string, timeoutMs = 20000): Promise<{ peer: Peer; link: Link }> {
  const peer = await openPeer();
  const diag = emptyDiagnostics();
  lastDiagnostics = diag;
  return new Promise((resolve, reject) => {
    const conn = peer.connect(peerIdForCode(code), { serialization: 'raw', reliable: true });
    // PeerJS builds the peer connection while negotiating; attach at once so no candidate is missed,
    // and keep polling in case negotiation was queued behind the socket opening.
    let watch = 0 as unknown as ReturnType<typeof setInterval>;
    if (conn.peerConnection) observe(conn.peerConnection, diag);
    else
      watch = setInterval(() => {
        if (conn.peerConnection) {
          clearInterval(watch);
          observe(conn.peerConnection, diag);
        }
      }, 25);
    const timer = setTimeout(() => {
      clearInterval(watch);
      peer.destroy();
      reject(new Error(explainFailure(diag)));
    }, timeoutMs);
    const fail = (err: Error & { type?: string }) => {
      clearInterval(watch);
      clearTimeout(timer);
      peer.destroy();
      reject(err.type === 'peer-unavailable' ? new Error('No room with that code. Check the code and that the host still has the tab open.') : err);
    };
    peer.once('error', fail);
    conn.once('open', () => {
      clearInterval(watch);
      clearTimeout(timer);
      peer.off('error', fail);
      const link = new Link(conn, false);
      link.start();
      resolve({ peer, link });
    });
    conn.once('error', (e) => fail(e as Error));
  });
}

/** Turn a stalled connection into something a player can act on. */
function explainFailure(diag: NetDiagnostics): string {
  if (!turnConfigured()) {
    return 'Found the room, but your two networks have no way to reach each other directly and no relay is set up. See Test connection.';
  }
  if (!diag.candidateTypes.includes('relay')) {
    return 'Found the room, but the relay did not answer. Check the relay credentials, or try again.';
  }
  return 'Found the room but the connection did not complete. Try again; if it keeps failing, the host should restart the room.';
}

/** Wrap each incoming connection on a hosting peer. */
export function acceptConnections(peer: Peer, onLink: (link: Link) => void): void {
  peer.on('connection', (conn) => {
    const diag = emptyDiagnostics();
    lastDiagnostics = diag;
    if (conn.peerConnection) observe(conn.peerConnection, diag);
    conn.once('open', () => {
      const link = new Link(conn, true);
      link.start();
      onLink(link);
    });
  });
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
