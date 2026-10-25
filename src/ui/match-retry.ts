/** State for the finished-match action. Identity guards prevent a pending request leaking rooms. */
export interface RetryState {
  session: object | null;
  game: object | null;
  host: boolean;
  finished: boolean;
  menuOpen: boolean;
}

export class MatchRetry {
  private pending: { session: object; game: object; until: number } | null = null;

  view(state: RetryState, now: number): { visible: boolean; pending: boolean } {
    if (this.pending && (this.pending.session !== state.session || this.pending.game !== state.game ||
        !state.finished || !state.host || now >= this.pending.until)) this.pending = null;
    return {
      visible: !!state.session && !!state.game && state.host && state.finished && !state.menuOpen,
      pending: !!this.pending,
    };
  }

  activate(state: RetryState, now: number, reset: () => void): boolean {
    const view = this.view(state, now);
    if (!view.visible || view.pending) return false;
    // Server resets complete asynchronously. A failed/lost request becomes retryable after 5 s.
    this.pending = { session: state.session!, game: state.game!, until: now + 5000 };
    try { reset(); }
    catch (error) { this.pending = null; throw error; }
    return true;
  }
}

/** Navigation may close the menu during this poll; that input still belongs to the menu. */
export function retryInputPressed(menuWasOpen: boolean, menuPressed: boolean, accept: boolean, resetPressed: boolean): boolean {
  return !menuWasOpen && !menuPressed && (accept || resetPressed);
}
