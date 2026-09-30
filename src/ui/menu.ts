import { ACTIONS, ACTION_LABELS, gamepadButtonName, keyName, type Action, type Captured, type InputManager } from '../input/input';
import type { FrameInput } from '../input/types';
import { CAR_BODIES } from '../render/cars';
import { CAMERA_DEFS, CONTROL_DEFS, DEFAULT_SETTINGS, GRAPHICS_DEFS, getSetting, setSetting, type SettingDef, type Settings } from '../settings';
import type { LobbyState } from '../net/session';
import { buildLabel } from '../build';

export type MenuScreen = 'main' | 'multiplayer' | 'lobby' | 'settings' | 'controls' | 'camera' | 'gameplay' | 'graphics' | 'garage' | 'hidden';
type PanelId = Exclude<MenuScreen, 'hidden'>;

/** What the menu is sitting on top of. Decides which main-menu buttons exist. */
export type MenuContext = { kind: 'none' } | { kind: 'local' } | { kind: 'host' | 'client'; inMatch: boolean };

/** Something the gamepad focus can land on. Buttons activate; slider rows adjust with left/right. */
interface Item {
  el: HTMLElement;
  row: number;
  col: number;
  activate?: () => void;
  adjust?: (dir: 1 | -1) => void;
}

interface Panel {
  el: HTMLElement;
  items: Item[];
  parent: MenuScreen;
  focus: number;
}

const REPEAT_DELAY = 0.4;
const REPEAT_INTERVAL = 0.12;
const NAME_KEY = 'rl-like.playerName.v1';
export const MATCH_LENGTHS = [0, 180, 300, 600];

export function matchLengthLabel(seconds: number): string {
  return seconds === 0 ? 'Unlimited' : `${Math.round(seconds / 60)} min`;
}

/**
 * DOM menu usable with mouse, keyboard (arrows / Enter / Backspace) and gamepad (D-pad or
 * stick, A accepts, B goes back). Screens: main → multiplayer → lobby, main → settings → ….
 */
export class Menu {
  screen: MenuScreen = 'main';
  context: MenuContext = { kind: 'none' };
  onPlay: (() => void) | null = null;
  onFreePlay: (() => void) | null = null;
  onQuit: (() => void) | null = null;
  onHost: ((name: string) => void) | null = null;
  onJoin: ((name: string, code: string) => void) | null = null;
  onTestConnection: (() => void) | null = null;
  onLeaveRoom: (() => void) | null = null;
  onSwitchTeam: (() => void) | null = null;
  onCycleMatchLength: (() => void) | null = null;
  onStartMatch: (() => void) | null = null;
  onEndMatch: (() => void) | null = null;
  onBindingsChanged: (() => void) | null = null;
  onSettingsChanged: (() => void) | null = null;

  private readonly root: HTMLElement;
  private readonly panels = {} as Record<PanelId, Panel>;
  private capturingCell: HTMLButtonElement | null = null;
  private heldDir: 'up' | 'down' | 'left' | 'right' | null = null;
  private repeatTimer = 0;
  private lobbyState: LobbyState | null = null;
  private mpStatus = '';
  private mpBusy = false;
  private nameInput!: HTMLInputElement;
  private codeInput!: HTMLInputElement;

  constructor(
    container: HTMLElement,
    private readonly input: InputManager,
    private readonly settings: Settings,
  ) {
    this.root = el('div', 'menu');
    this.buildMain();
    this.buildMultiplayer();
    this.buildLobby();
    this.buildSettingsHub();
    this.buildControls();
    this.buildSliders('camera', 'Camera', CAMERA_DEFS, 'settings');
    this.buildSliders('gameplay', 'Gameplay', CONTROL_DEFS, 'settings');
    this.buildSliders('graphics', 'Graphics', GRAPHICS_DEFS, 'settings');
    this.buildGarage();
    // Build stamp, visible on every menu screen: quote it when reporting something.
    const version = el('div', 'build-stamp');
    version.textContent = buildLabel();
    version.title = 'Build identifier — include this when reporting a problem';
    this.root.appendChild(version);
    container.appendChild(this.root);
    this.show('main');
  }

  get open(): boolean {
    return this.screen !== 'hidden';
  }

  get playerName(): string {
    return this.nameInput.value.trim() || 'Player';
  }

  show(screen: MenuScreen): void {
    if (this.capturingCell) this.cancelCapture();
    this.screen = screen;
    this.root.hidden = screen === 'hidden';
    // The Garage shows the car preview behind a see-through menu.
    this.root.classList.toggle('garage', screen === 'garage');
    for (const [id, p] of Object.entries(this.panels) as [PanelId, Panel][]) p.el.hidden = id !== screen;
    if (screen === 'main') this.renderMain();
    if (screen === 'multiplayer') this.renderMultiplayer();
    if (screen === 'lobby') this.renderLobby();
    if (screen === 'garage') this.renderGarage();
    if (screen !== 'hidden') this.setFocus(this.panels[screen].focus);
    else blurTextField();
    this.heldDir = null;
  }

  /** Menu button while playing opens the menu; inside the menu it backs out one level. */
  toggle(): void {
    if (this.screen === 'hidden') this.show(this.context.kind === 'none' ? 'main' : 'main');
    else this.back();
  }

  back(): void {
    if (this.screen === 'hidden') return;
    if (this.capturingCell) {
      this.cancelCapture();
      return;
    }
    if (isTyping()) {
      blurTextField();
      return;
    }
    const parent = this.panels[this.screen].parent;
    if (parent === 'hidden') {
      if (this.canResume()) this.play();
    } else if (this.screen === 'lobby') {
      // Backing out of the lobby returns to the match if one is running, otherwise stays: leaving is explicit.
      if (this.canResume()) this.play();
    } else this.show(parent);
  }

  /** Feed navigation every frame while open. */
  navigate(nav: FrameInput['nav'], dt: number): void {
    if (this.screen === 'hidden' || this.input.capturing) return;
    const dir = nav.upHeld ? 'up' : nav.downHeld ? 'down' : nav.leftHeld ? 'left' : nav.rightHeld ? 'right' : null;
    if (dir !== this.heldDir) {
      this.heldDir = dir;
      if (dir) {
        this.move(dir);
        this.repeatTimer = REPEAT_DELAY;
      }
    } else if (dir) {
      this.repeatTimer -= dt;
      if (this.repeatTimer <= 0) {
        this.move(dir);
        this.repeatTimer = REPEAT_INTERVAL;
      }
    }
    if (nav.accept) this.activateFocused();
    if (nav.back) this.back();
  }

  // ---------------------------------------------------------------------------
  // State from outside
  // ---------------------------------------------------------------------------

  setContext(ctx: MenuContext): void {
    this.context = ctx;
    if (this.screen === 'main') this.renderMain();
    if (this.screen === 'lobby') this.renderLobby();
  }

  setLobby(state: LobbyState | null): void {
    this.lobbyState = state;
    if (this.screen === 'lobby') this.renderLobby();
  }

  setMultiplayerStatus(text: string, busy = false): void {
    this.mpStatus = text;
    this.mpBusy = busy;
    if (this.screen === 'multiplayer') this.renderMultiplayer();
  }

  private canResume(): boolean {
    const c = this.context;
    return c.kind === 'local' || ((c.kind === 'host' || c.kind === 'client') && c.inMatch);
  }

  // ---------------------------------------------------------------------------
  // Focus handling
  // ---------------------------------------------------------------------------

  private get panel(): Panel | null {
    return this.screen === 'hidden' ? null : this.panels[this.screen];
  }

  private setFocus(index: number): void {
    const p = this.panel;
    if (!p || p.items.length === 0) return;
    p.focus = Math.max(0, Math.min(p.items.length - 1, index));
    p.items.forEach((it, i) => it.el.classList.toggle('focused', i === p.focus));
    const focused = p.items[p.focus].el;
    if (isTyping() && document.activeElement !== focused && !focused.contains(document.activeElement)) blurTextField();
    focused.scrollIntoView({ block: 'nearest' });
  }

  private move(dir: 'up' | 'down' | 'left' | 'right'): void {
    const p = this.panel;
    if (!p || p.items.length === 0) return;
    const cur = p.items[p.focus];
    if ((dir === 'left' || dir === 'right') && cur.adjust) {
      cur.adjust(dir === 'right' ? 1 : -1);
      return;
    }
    let best = -1;
    let bestScore = Infinity;
    p.items.forEach((it, i) => {
      if (i === p.focus) return;
      let ok = false;
      let score = 0;
      if (dir === 'up' || dir === 'down') {
        ok = dir === 'up' ? it.row < cur.row : it.row > cur.row;
        score = Math.abs(it.row - cur.row) * 10 + Math.abs(it.col - cur.col);
      } else {
        ok = it.row === cur.row && (dir === 'left' ? it.col < cur.col : it.col > cur.col);
        score = Math.abs(it.col - cur.col);
      }
      if (ok && score < bestScore) {
        bestScore = score;
        best = i;
      }
    });
    if (best >= 0) this.setFocus(best);
  }

  private activateFocused(): void {
    const p = this.panel;
    if (!p || p.items.length === 0) return;
    p.items[p.focus].activate?.();
  }

  private addPanel(id: PanelId, parent: MenuScreen, title: string, wide = false): Panel {
    const panelEl = el('div', 'menu-panel' + (wide ? ' wide' : ''));
    const h = el(id === 'main' ? 'h1' : 'h2', 'menu-title');
    h.textContent = title;
    panelEl.appendChild(h);
    const panel: Panel = { el: panelEl, items: [], parent, focus: 0 };
    this.panels[id] = panel;
    this.root.appendChild(panelEl);
    return panel;
  }

  private addButton(panel: Panel, parentEl: HTMLElement, text: string, row: number, col: number, onClick: () => void): HTMLButtonElement {
    const b = button(text, onClick);
    parentEl.appendChild(b);
    panel.items.push({ el: b, row, col, activate: onClick });
    return b;
  }

  // ---------------------------------------------------------------------------
  // Main
  // ---------------------------------------------------------------------------

  private mainButtons!: HTMLElement;

  private buildMain(): void {
    const p = this.addPanel('main', 'hidden', '');
    const title = p.el.querySelector('.menu-title')!;
    title.innerHTML = 'RL<span class="accent">-</span>like';
    const sub = el('div', 'menu-subtitle');
    sub.textContent = 'Browser car soccer';
    title.after(sub);
    this.mainButtons = el('div', 'menu-stack');
    p.el.appendChild(this.mainButtons);
    const hint = el('p', 'menu-hint');
    hint.innerHTML =
      '<span class="btn-glyph">Esc</span> / <span class="btn-glyph">Start</span> opens this menu during play. ' +
      'Navigate with the D-pad or stick, <span class="btn-glyph">A</span> selects, <span class="btn-glyph">B</span> goes back. ' +
      'Keyboard: arrows, <kbd>Enter</kbd>, <kbd>Backspace</kbd>.';
    p.el.appendChild(hint);
    this.renderMain();
  }

  private renderMain(): void {
    const p = this.panels.main;
    const focus = p.focus;
    this.mainButtons.replaceChildren();
    p.items = [];
    let row = 0;
    const c = this.context;
    if (c.kind === 'none') {
      this.addButton(p, this.mainButtons, 'Free Play', row++, 0, () => this.onFreePlay?.()).classList.add('primary');
      this.addButton(p, this.mainButtons, 'Multiplayer', row++, 0, () => this.show('multiplayer'));
    } else if (c.kind === 'local') {
      this.addButton(p, this.mainButtons, 'Resume Free Play', row++, 0, () => this.play()).classList.add('primary');
      this.addButton(p, this.mainButtons, 'Multiplayer', row++, 0, () => {
        this.onQuit?.();
        this.show('multiplayer');
      });
    } else {
      if (c.inMatch) this.addButton(p, this.mainButtons, 'Resume Match', row++, 0, () => this.play()).classList.add('primary');
      const lobbyBtn = this.addButton(p, this.mainButtons, 'Lobby', row++, 0, () => this.show('lobby'));
      if (!c.inMatch) lobbyBtn.classList.add('primary');
    }
    this.addButton(p, this.mainButtons, 'Garage', row++, 0, () => this.show('garage'));
    this.addButton(p, this.mainButtons, 'Settings', row++, 0, () => this.show('settings'));
    if (c.kind === 'local') this.addButton(p, this.mainButtons, 'Quit to Menu', row++, 0, () => this.onQuit?.()).classList.add('danger');
    if (c.kind === 'host' || c.kind === 'client') this.addButton(p, this.mainButtons, 'Leave Room', row++, 0, () => this.onLeaveRoom?.()).classList.add('danger');
    p.focus = Math.min(focus, p.items.length - 1);
    if (this.screen === 'main') this.setFocus(p.focus);
  }

  // ---------------------------------------------------------------------------
  // Multiplayer: name, host, join
  // ---------------------------------------------------------------------------

  private mpStatusEl!: HTMLElement;
  private mpReportEl!: HTMLElement;
  private mpButtons: HTMLButtonElement[] = [];

  private buildMultiplayer(): void {
    const p = this.addPanel('multiplayer', 'main', 'Multiplayer');
    const hint = el('p', 'menu-hint');
    hint.textContent = 'One player hosts from their browser; friends join with the room code. Everyone plays with their own physics prediction, so keep the host on a good connection.';
    p.el.appendChild(hint);

    const nameRow = el('div', 'field-row');
    const nameLabel = el('label', 'field-label');
    nameLabel.textContent = 'Your name';
    this.nameInput = document.createElement('input');
    this.nameInput.className = 'menu-input';
    this.nameInput.maxLength = 16;
    this.nameInput.placeholder = 'Player';
    this.nameInput.value = loadName();
    this.nameInput.addEventListener('change', () => saveName(this.nameInput.value));
    this.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') this.nameInput.blur();
    });
    nameRow.append(nameLabel, this.nameInput);
    p.el.appendChild(nameRow);
    p.items.push({ el: nameRow, row: 0, col: 0, activate: () => this.nameInput.focus() });

    const hostBtn = this.addButton(p, p.el, 'Host a room', 1, 0, () => this.hostClicked());
    hostBtn.classList.add('primary');

    const joinRow = el('div', 'field-row');
    const codeLabel = el('label', 'field-label');
    codeLabel.textContent = 'Room code';
    this.codeInput = document.createElement('input');
    this.codeInput.className = 'menu-input code';
    this.codeInput.maxLength = 8;
    this.codeInput.placeholder = 'ABCDE';
    this.codeInput.autocapitalize = 'characters';
    this.codeInput.addEventListener('input', () => {
      this.codeInput.value = this.codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    });
    this.codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        this.codeInput.blur();
        this.joinClicked();
      } else if (e.key === 'Escape') this.codeInput.blur();
    });
    joinRow.append(codeLabel, this.codeInput);
    p.el.appendChild(joinRow);
    p.items.push({ el: joinRow, row: 2, col: 0, activate: () => this.codeInput.focus() });
    const joinBtn = this.addButton(p, p.el, 'Join room', 3, 0, () => this.joinClicked());

    this.mpStatusEl = el('p', 'menu-status');
    p.el.appendChild(this.mpStatusEl);
    const testBtn = this.addButton(p, p.el, 'Test connection', 4, 0, () => this.onTestConnection?.());
    testBtn.classList.add('subtle');
    this.mpReportEl = el('div', 'net-report');
    this.mpReportEl.hidden = true;
    p.el.appendChild(this.mpReportEl);
    this.addButton(p, p.el, 'Back', 5, 0, () => this.back());
    this.mpButtons = [hostBtn, joinBtn];
  }

  private renderMultiplayer(): void {
    this.mpStatusEl.textContent = this.mpStatus;
    this.mpStatusEl.classList.toggle('busy', this.mpBusy);
    for (const b of this.mpButtons) b.disabled = this.mpBusy;
  }

  /** Show the result of a connection test (plain lines; empty string hides the block). */
  setConnectionReport(lines: string): void {
    this.mpReportEl.textContent = lines;
    this.mpReportEl.hidden = lines === '';
  }

  private hostClicked(): void {
    if (this.mpBusy) return;
    saveName(this.nameInput.value);
    this.onHost?.(this.playerName);
  }

  private joinClicked(): void {
    if (this.mpBusy) return;
    const code = this.codeInput.value.trim().toUpperCase();
    if (code.length < 4) {
      this.setMultiplayerStatus('Enter the room code your host sees in their lobby.');
      return;
    }
    saveName(this.nameInput.value);
    this.onJoin?.(this.playerName, code);
  }

  // ---------------------------------------------------------------------------
  // Lobby
  // ---------------------------------------------------------------------------

  private lobbyBody!: HTMLElement;

  private buildLobby(): void {
    const p = this.addPanel('lobby', 'main', 'Lobby', true);
    this.lobbyBody = el('div', 'lobby');
    p.el.appendChild(this.lobbyBody);
  }

  private renderLobby(): void {
    const p = this.panels.lobby;
    const focus = p.focus;
    p.items = [];
    this.lobbyBody.replaceChildren();
    const s = this.lobbyState;
    const title = p.el.querySelector('.menu-title')!;
    if (!s) {
      title.textContent = 'Lobby';
      const msg = el('p', 'menu-hint');
      msg.textContent = 'Not in a room.';
      this.lobbyBody.appendChild(msg);
      this.addButton(p, this.lobbyBody, 'Back', 0, 0, () => this.show('multiplayer'));
      p.focus = 0;
      if (this.screen === 'lobby') this.setFocus(0);
      return;
    }
    title.innerHTML = `Room <span class="accent code">${escapeHtml(s.code)}</span>`;
    const status = el('div', 'lobby-status');
    status.textContent = s.inMatch ? 'Match in progress' : s.isHost ? 'Share the code. Start when everyone is in.' : 'Waiting for the host to start.';
    this.lobbyBody.appendChild(status);

    const teams = el('div', 'lobby-teams');
    for (const team of ['blue', 'orange'] as const) {
      const col = el('div', `lobby-team ${team}`);
      const head = el('div', 'lobby-team-title');
      head.textContent = team.toUpperCase();
      col.appendChild(head);
      const members = s.players.filter((pl) => pl.team === team);
      if (members.length === 0) {
        const empty = el('div', 'lobby-player empty');
        empty.textContent = '—';
        col.appendChild(empty);
      }
      for (const pl of members) {
        const row = el('div', 'lobby-player' + (pl.slot === s.mySlot ? ' me' : ''));
        row.textContent = pl.name + (pl.slot === 0 ? ' (host)' : '') + (pl.slot === s.mySlot ? ' · you' : '');
        col.appendChild(row);
      }
      teams.appendChild(col);
    }
    this.lobbyBody.appendChild(teams);

    const controls = el('div', 'menu-row wrap');
    this.lobbyBody.appendChild(controls);
    let col = 0;
    this.addButton(p, controls, 'Switch team', 0, col++, () => this.onSwitchTeam?.());
    if (s.isHost) {
      this.addButton(p, controls, `Match length: ${matchLengthLabel(s.settings.matchSeconds)}`, 0, col++, () => this.onCycleMatchLength?.());
    } else {
      const info = el('div', 'lobby-info');
      info.textContent = `Match length: ${matchLengthLabel(s.settings.matchSeconds)}`;
      controls.appendChild(info);
    }

    const actions = el('div', 'menu-row wrap');
    this.lobbyBody.appendChild(actions);
    col = 0;
    if (s.inMatch) this.addButton(p, actions, 'Return to match', 1, col++, () => this.play()).classList.add('primary');
    if (s.isHost) {
      if (!s.inMatch) this.addButton(p, actions, 'Start match', 1, col++, () => this.onStartMatch?.()).classList.add('primary');
      else this.addButton(p, actions, 'End match', 1, col++, () => this.onEndMatch?.());
    }
    this.addButton(p, actions, 'Leave room', 1, col++, () => this.onLeaveRoom?.()).classList.add('danger');

    const hint = el('p', 'menu-hint');
    hint.textContent = s.isHost
      ? 'Your browser runs the match: keep this tab open and in the foreground. Players can join mid-match with the same code.'
      : 'The host runs the match. If they close their tab, the room ends.';
    this.lobbyBody.appendChild(hint);

    p.focus = Math.min(focus, p.items.length - 1);
    if (this.screen === 'lobby') this.setFocus(p.focus);
  }

  // ---------------------------------------------------------------------------
  // Garage: pick a car body (cosmetic; every body shares the same hitbox)
  // ---------------------------------------------------------------------------

  private garageButtons: HTMLButtonElement[] = [];
  private garageBlurb!: HTMLElement;

  private buildGarage(): void {
    const p = this.addPanel('garage', 'main', 'Garage');
    p.el.classList.add('garage-panel');
    const row = el('div', 'menu-row');
    p.el.appendChild(row);
    this.garageButtons = CAR_BODIES.map((b, i) =>
      this.addButton(p, row, b.name, 0, i, () => {
        this.settings.car.body = i;
        this.renderGarage();
        this.onSettingsChanged?.();
      }),
    );
    this.garageBlurb = el('p', 'menu-hint');
    p.el.appendChild(this.garageBlurb);
    const note = el('p', 'menu-hint');
    note.textContent = 'Looks only: every car has the same hitbox and handling.';
    p.el.appendChild(note);
    const footer = el('div', 'menu-row');
    p.el.appendChild(footer);
    this.addButton(p, footer, 'Back', 1, 0, () => this.back());
  }

  private renderGarage(): void {
    const chosen = this.settings.car.body;
    this.garageButtons.forEach((b, i) => b.classList.toggle('primary', i === chosen));
    this.garageBlurb.textContent = CAR_BODIES[chosen]?.blurb ?? '';
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  private buildSettingsHub(): void {
    const p = this.addPanel('settings', 'main', 'Settings');
    this.addButton(p, p.el, 'Controls', 0, 0, () => this.show('controls'));
    this.addButton(p, p.el, 'Camera', 1, 0, () => this.show('camera'));
    this.addButton(p, p.el, 'Gameplay', 2, 0, () => this.show('gameplay'));
    this.addButton(p, p.el, 'Graphics', 3, 0, () => this.show('graphics'));
    this.addButton(p, p.el, 'Back', 4, 0, () => this.back());
  }

  private buildControls(): void {
    const p = this.addPanel('controls', 'settings', 'Controls', true);
    const hint = el('p', 'menu-hint');
    hint.textContent = 'Select a binding, then press the gamepad button or key. Esc cancels.';
    p.el.appendChild(hint);
    const table = el('div', 'bind-table');
    p.el.appendChild(table);
    const footer = el('div', 'menu-row');
    p.el.appendChild(footer);

    const render = () => {
      // Rebuild the table and the item list (footer buttons re-added after).
      table.replaceChildren();
      p.items = [];
      const header = el('div', 'bind-row bind-head');
      for (const t of ['Action', 'Gamepad', 'Keyboard']) {
        const c = el('div');
        c.textContent = t;
        header.appendChild(c);
      }
      table.appendChild(header);
      ACTIONS.forEach((action, r) => {
        const row = el('div', 'bind-row');
        const name = el('div');
        name.textContent = ACTION_LABELS[action];
        row.appendChild(name);
        row.appendChild(this.bindCell(p, action, 'gamepad', r, 1, render));
        row.appendChild(this.bindCell(p, action, 'key', r, 2, render));
        table.appendChild(row);
      });
      footer.replaceChildren();
      const r = ACTIONS.length;
      this.addButton(p, footer, 'Reset to defaults', r, 1, () => {
        this.input.resetBindings();
        render();
        this.onBindingsChanged?.();
      });
      this.addButton(p, footer, 'Back', r, 2, () => this.back());
      if (this.screen === 'controls') this.setFocus(p.focus);
    };
    render();
  }

  private bindCell(p: Panel, action: Action, kind: 'gamepad' | 'key', row: number, col: number, rerender: () => void): HTMLButtonElement {
    const b = this.input.bindings;
    const label = kind === 'gamepad' ? gamepadButtonName(b.gamepad[action]) : keyName(b.keyboard[action]);
    const cell = button(label, () => {
      if (this.capturingCell) this.cancelCapture();
      this.capturingCell = cell;
      cell.textContent = 'Press…';
      cell.classList.add('capturing');
      const onCapture = (c: Captured) => {
        if (c.kind !== kind) {
          this.input.startCapture(onCapture); // wrong device, keep waiting
          return;
        }
        this.input.rebind(action, c);
        this.capturingCell = null;
        rerender();
        this.onBindingsChanged?.();
      };
      this.input.startCapture(onCapture);
    });
    cell.classList.add('bind-cell');
    p.items.push({ el: cell, row, col, activate: () => cell.click() });
    return cell;
  }

  private cancelCapture(): void {
    this.input.cancelCapture();
    this.capturingCell = null;
    this.rerenderPanel('controls');
  }

  private rerenderPanel(id: PanelId): void {
    const p = this.panels[id];
    const focus = p.focus;
    // Cheap approach: rebuild the whole panel's dynamic parts by re-invoking its builder.
    if (id === 'controls') {
      this.root.removeChild(p.el);
      this.buildControls();
      this.panels.controls.focus = focus;
      if (this.screen === 'controls') {
        this.panels.controls.el.hidden = false;
        this.setFocus(focus);
      } else this.panels.controls.el.hidden = true;
    }
  }

  private buildSliders(id: PanelId, title: string, defs: SettingDef[], parent: MenuScreen): void {
    const p = this.addPanel(id, parent, title, true);
    const list = el('div', 'slider-list');
    p.el.appendChild(list);

    defs.forEach((def, r) => {
      const row = el('div', 'slider-row');
      const name = el('div', 'slider-label');
      const title = el('div', 'slider-title');
      title.textContent = def.label;
      const desc = el('div', 'slider-desc');
      desc.textContent = def.description;
      name.append(title, desc);
      const minus = button('−', () => adjust(-1));
      minus.classList.add('adj');
      const val = el('div', 'slider-value');
      const plus = button('+', () => adjust(1));
      plus.classList.add('adj');
      const bar = el('div', 'slider-bar');
      const fill = el('div', 'slider-fill');
      bar.appendChild(fill);
      row.append(name, minus, val, plus, bar);
      list.appendChild(row);

      const refresh = () => {
        const v = getSetting(this.settings, def);
        val.textContent = def.labels ? (def.labels[Math.round(v)] ?? String(v)) : `${v.toFixed(def.decimals)}${def.unit ?? ''}`;
        fill.style.width = `${((v - def.min) / (def.max - def.min)) * 100}%`;
      };
      const adjust = (dir: 1 | -1) => {
        setSetting(this.settings, def, getSetting(this.settings, def) + dir * def.step);
        refresh();
        this.onSettingsChanged?.();
      };
      refresh();
      p.items.push({ el: row, row: r, col: 0, adjust, activate: () => adjust(1) });
      (row as HTMLElement & { refresh?: () => void }).refresh = refresh;
    });

    const footer = el('div', 'menu-row');
    p.el.appendChild(footer);
    this.addButton(p, footer, 'Reset to defaults', defs.length, 0, () => {
      for (const section of new Set(defs.map((d) => d.section))) {
        Object.assign(this.settings[section], structuredClone(DEFAULT_SETTINGS[section]));
      }
      for (const row of list.children) (row as HTMLElement & { refresh?: () => void }).refresh?.();
      this.onSettingsChanged?.();
    });
    this.addButton(p, footer, 'Back', defs.length, 1, () => this.back());
  }

  /** Hide the menu and hand control back to the game. */
  play(): void {
    if (!this.canResume()) return;
    this.show('hidden');
    this.onPlay?.();
  }
}

function el(tag: string, className?: string): HTMLElement {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'menu-button';
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

function isTyping(): boolean {
  const a = document.activeElement;
  return a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement;
}

function blurTextField(): void {
  if (isTyping()) (document.activeElement as HTMLElement).blur();
}

function loadName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

function saveName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name.trim().slice(0, 16));
  } catch {
    /* ignore */
  }
}
