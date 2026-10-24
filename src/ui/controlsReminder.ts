import { gamepadButtonName, keyName, type Action, type InputManager } from '../input/input';

/** Optional, non-modal help. It never pauses or changes the session. */
export class ControlsReminder {
  private readonly root = document.createElement('aside');
  private readonly details = document.createElement('details');
  private readonly rows = document.createElement('div');
  private readonly padStatus = document.createElement('p');
  private requested = false;
  private signature = '';

  constructor(container: HTMLElement, private readonly input: InputManager) {
    this.root.id = 'controlsReminder';
    this.root.hidden = true;
    this.root.setAttribute('aria-label', 'Controls reminder');
    window.addEventListener('keydown', (event) => {
      if (event.code !== 'Tab' || this.root.hidden) return;
      // Keep native Tab / Shift+Tab focus navigation, but do not also drive,
      // reset or open the menu when Tab has been assigned a gameplay action.
      this.input.consumeKeyUntilRelease(event.code);
      event.stopPropagation();
    }, true);
    const header = document.createElement('div');
    header.className = 'controls-reminder-header';
    const title = document.createElement('strong');
    title.textContent = 'Controls';
    const close = document.createElement('button');
    close.type = 'button';
    close.id = 'closeControlsReminder';
    close.textContent = 'Close';
    close.setAttribute('aria-label', 'Close controls reminder');
    close.addEventListener('click', () => this.hide());
    close.addEventListener('keydown', (event) => {
      if (event.code !== 'Enter' && event.code !== 'Space') return;
      event.preventDefault();
      event.stopPropagation();
      this.input.consumeKeyUntilRelease(event.code);
      if (!event.repeat) this.hide();
    });
    header.append(title, close);
    const hint = document.createElement('p');
    hint.className = 'controls-reminder-dismiss';
    hint.textContent = 'Close: Tab → Enter/Space · Hold D-pad Up, then press B';
    const summary = document.createElement('summary');
    summary.textContent = 'Show bindings';
    summary.addEventListener('keydown', (event) => {
      if (event.code !== 'Enter' && event.code !== 'Space') return;
      event.preventDefault();
      event.stopPropagation();
      this.input.consumeKeyUntilRelease(event.code);
      if (!event.repeat) this.details.open = !this.details.open;
    });
    this.details.append(summary, this.rows, this.padStatus);
    this.root.append(header, hint, this.details);
    container.appendChild(this.root);
  }

  show(): void {
    this.requested = true;
    // Small or short screens start compact; bindings remain touch/keyboard accessible.
    this.details.open = !matchMedia('(max-width: 560px), (max-height: 580px)').matches;
    this.refresh(null);
  }

  hide(): void {
    this.requested = false;
    this.root.hidden = true;
    if (this.root.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  }

  /** Run before polling input so a dismissal cannot also drive or navigate this frame. */
  update(active: boolean, controllerName: string | null): void {
    this.root.hidden = !this.requested || !active;
    if (this.root.hidden) return;
    this.refresh(controllerName);
    if (this.input.consumeGamepadChord(12, 1)) this.hide();
  }

  refresh(controllerName: string | null): void {
    const bindings = this.input.bindings;
    const signature = JSON.stringify([bindings, controllerName]);
    if (signature === this.signature) return;
    this.signature = signature;
    this.rows.replaceChildren();
    const row = (action: string, label: string, keyboard: string, gamepad: string) => {
      const line = document.createElement('div');
      line.className = 'controls-reminder-row';
      line.dataset.action = action;
      for (const [column, value] of [['action', label], ['keyboard', keyboard], ['gamepad', gamepad]]) {
        const cell = document.createElement('span');
        cell.dataset.column = column;
        cell.textContent = value;
        line.appendChild(cell);
      }
      this.rows.appendChild(line);
    };
    const key = (action: Action) => keyName(bindings.keyboard[action]) || 'Unassigned';
    const pad = (action: Action) => gamepadButtonName(bindings.gamepad[action]);
    row('headings', '', 'Keyboard', 'Gamepad');
    row('throttle', 'Drive', `${key('throttle')} / ↑`, pad('throttle'));
    row('reverse', 'Reverse', `${key('reverse')} / ↓`, pad('reverse'));
    row('steer', 'Steer', 'A / D · ← / →', 'Left stick');
    for (const [action, label] of [['jump', 'Jump'], ['boost', 'Boost'], ['ballCam', 'Ball cam']] as const) {
      row(action, label, key(action), pad(action));
    }
    this.padStatus.textContent = controllerName ? 'Standard gamepad connected' : 'Standard gamepad · not connected';
  }
}
