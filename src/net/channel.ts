import type { CtrlMsg } from './protocol';

/** Simulation clients depend on this channel, not on a browser-specific transport. */
export interface GameLink {
  onCtrl: ((msg: CtrlMsg) => void) | null;
  onFast: ((buf: ArrayBuffer) => void) | null;
  onClose: (() => void) | null;
  sendCtrl(msg: CtrlMsg): void;
  /** Non-consuming input preflight; sendFast still owns the final transport checks. */
  canSendInputs?(): boolean;
  sendFast(buf: ArrayBuffer): void;
  close(): void;
}
