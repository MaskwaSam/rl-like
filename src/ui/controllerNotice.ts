/** Transient feedback from authoritative frame polls; never handles input or focus. */
export class ControllerNotice {
  private readonly root = document.createElement('div');
  private readonly status = document.createElement('div');
  private readonly icon = document.createElement('span');
  private readonly title = document.createElement('strong');
  private readonly detail = document.createElement('span');
  private previousName: string | null | undefined;
  private wasActive = false;
  private expiresAt = 0;

  constructor(container: HTMLElement) {
    this.root.id = 'controllerNotice';
    this.root.hidden = true;
    this.root.setAttribute('aria-hidden', 'true');
    // Keep the empty live region exposed before any later text update. The visual
    // pill can then hide/fade without suppressing or duplicating announcements.
    this.status.id = 'controllerNoticeStatus';
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    this.status.setAttribute('aria-atomic', 'true');
    this.icon.className = 'controller-notice-icon';
    this.icon.setAttribute('aria-hidden', 'true');
    this.title.id = 'controllerNoticeTitle';
    this.detail.id = 'controllerNoticeDetail';
    const copy = document.createElement('div');
    copy.append(this.title, this.detail);
    this.root.append(this.icon, copy);
    container.appendChild(this.root);
    container.appendChild(this.status);
  }

  /** Menus and session boundaries discard pending notices, including their fade. */
  reset(): void {
    this.wasActive = false;
    this.clear();
  }

  private clear(): void {
    if (!this.expiresAt) return;
    this.expiresAt = 0;
    this.root.hidden = true;
    this.root.classList.remove('visible');
    this.title.textContent = '';
    this.detail.textContent = '';
    this.status.textContent = '';
  }

  update(name: string | null, active: boolean, now: number): void {
    const changed = this.previousName !== undefined && name !== this.previousName;
    this.previousName = name;
    if (!active) {
      this.reset();
      return;
    }
    // Entering play establishes a baseline; menu changes never replay on resume.
    if (this.wasActive && changed) {
      const connected = name !== null;
      this.root.dataset.state = connected ? 'connected' : 'disconnected';
      this.icon.textContent = connected ? '✓' : '!';
      this.title.textContent = connected ? 'Controller connected' : 'Controller disconnected';
      this.detail.textContent = connected ? name : 'Reconnect to use your controller.';
      this.status.textContent = `${this.title.textContent}. ${this.detail.textContent}`;
      this.root.hidden = false;
      this.root.classList.add('visible');
      this.expiresAt = now + (connected ? 4000 : 6000);
    }
    this.wasActive = true;
    if (this.expiresAt && now >= this.expiresAt) {
      this.root.classList.remove('visible');
      if (now >= this.expiresAt + 220) this.clear();
    }
  }
}
