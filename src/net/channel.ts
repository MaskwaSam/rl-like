import type { CtrlMsg } from './protocol';

/** Simulation clients depend on this channel, not on a browser-specific transport. */
export interface GameLink {
  onCtrl: ((msg: CtrlMsg) => void) | null;
  onFast: ((buf: ArrayBuffer) => void) | null;
  onClose: (() => void) | null;
  sendCtrl(msg: CtrlMsg): void;
  sendFast(buf: ArrayBuffer): void;
  close(): void;
}
