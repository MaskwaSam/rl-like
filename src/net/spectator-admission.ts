/** One-shot admission result shared by welcome, terminal link events, and timeout. */
export function createSpectatorAdmission(timeoutMs: number, onTimeout: () => void) {
  let settled = false;
  let settleResult!: (reason: string | null) => void;
  const promise = new Promise<void>((resolve, reject) => {
    settleResult = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (reason) reject(new Error(reason));
      else resolve();
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settleResult('The host did not answer. It may need to reload to the latest version to allow spectators.');
      onTimeout();
    }, timeoutMs);
  });
  return { promise, settle: (reason: string | null) => settleResult(reason) };
}
