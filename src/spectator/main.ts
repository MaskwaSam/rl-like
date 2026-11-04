/**
 * Spectator app: watch a LAN play room without taking a car. Overview (broadcast or full field),
 * any player's chase camera (ball cam or car cam), or a free-flying camera.
 */
import '../ui/presentation.css';
import './spectator.css';
import { normalizeArena } from '../arenas';
import { CAR, UU } from '../sim/rl';
import { buildArenaGeometry } from '../sim/arena';
import { FREE_PLAY_CONFIG, Game, type Team } from '../sim/game';
import { Renderer } from '../render/renderer';
import { loadMaskwaArt } from '../render/maskwa';
import { FollowCamera } from '../render/camera';
import { SoundManager } from '../audio/sound';
import { loadSettings } from '../settings';
import { buildLabel } from '../build';
import { SpectatorSession } from '../net/spectator';
import { describeError, loadIceConfig, normalizeCode } from '../net/transport';
import type { LobbyPlayer } from '../net/protocol';
import { FreeCamera, OverviewCamera, type FreeCamInput } from './cameras';

type Mode = 'overview' | 'player' | 'free';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const TEAM_COLOR: Record<Team, string> = { blue: '#4aa3ff', orange: '#ff9a3c' };
const UU_S_TO_KMH = 0.036;
const GAUGE_FULL = 2 * Math.PI * 56;
const GAUGE_CIRCUMFERENCE = GAUGE_FULL * 0.78;
const LOOK_SENSITIVITY = 0.0025;
const STICK_LOOK_RATE = 2.6;
const DEADZONE = 0.15;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

function formatClock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Blue then orange, each by slot: number keys 1–8 follow this order. */
function ordered(players: LobbyPlayer[]): LobbyPlayer[] {
  return [...players].sort((a, b) => (a.team === b.team ? a.slot - b.slot : a.team === 'blue' ? -1 : 1));
}

function buildOverlay(): void {
  const root = document.createElement('div');
  root.id = 'spectator';
  root.innerHTML = `
    <div class="spectator-screen" id="specJoin">
      <section class="menu-panel" aria-labelledby="specJoinTitle">
        <h1 class="menu-title" id="specJoinTitle">CAR SOCCER <span class="accent">SPECTATOR</span></h1>
        <p class="menu-subtitle">Watch a LAN play room live</p>
        <form id="specJoinForm">
          <input id="specCode" class="menu-input code" maxlength="8" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="CODE" aria-label="Room code" required />
          <button class="menu-button primary" type="submit" id="specWatch">Watch</button>
        </form>
        <p class="menu-status" id="specStatus" role="status" aria-live="polite"></p>
        <p class="menu-hint">Enter the code shown in the host's LAN play lobby. Spectators take no car and send no inputs.
          For the lowest delay, watch from the same network as the host.</p>
        <p class="menu-hint" id="specBuild"></p>
      </section>
    </div>
    <div class="spectator-screen" id="specWait" hidden>
      <section class="menu-panel" aria-labelledby="specWaitTitle">
        <h2 class="menu-title" id="specWaitTitle">Watching <span class="code" id="specWaitCode"></span></h2>
        <p class="lobby-status" id="specWaitStatus">Waiting for the host to start the match…</p>
        <div class="spectator-roster" id="specRoster"></div>
        <div class="menu-row"><button class="menu-button danger" type="button" id="specLeaveWait">Stop watching</button></div>
      </section>
    </div>
    <div class="spectator-follow" id="specFollow" hidden></div>
    <div class="spectator-help" id="specHelp" hidden>
      <strong>Spectator controls</strong><br />
      <kbd>O</kbd> overview (again: broadcast / full field)<br />
      <kbd>1</kbd>–<kbd>8</kbd> follow a player · <kbd>←</kbd><kbd>→</kbd> or <kbd>Tab</kbd> next/previous<br />
      <kbd>B</kbd> ball cam / car cam<br />
      <kbd>F</kbd> free camera: <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> move, mouse look (click to capture),
      <kbd>Space</kbd>/<kbd>E</kbd> up, <kbd>Q</kbd>/<kbd>Ctrl</kbd> down, <kbd>Shift</kbd> fast<br />
      <kbd>H</kbd> hide overlay · <kbd>?</kbd> this help<br />
      Controller: sticks fly, <kbd>LT</kbd>/<kbd>RT</kbd> down/up, <kbd>LB</kbd>/<kbd>RB</kbd> players, <kbd>A</kbd> ball cam, <kbd>X</kbd> next view, <kbd>Y</kbd> overview, <kbd>Start</kbd> overlay
    </div>
    <div class="spectator-bar" id="specBar" hidden>
      <div class="spectator-players" id="specPlayers"></div>
      <div class="spectator-modes">
        <button type="button" data-mode="overview">Overview<kbd>O</kbd></button>
        <button type="button" data-mode="player">Players<kbd>1–8</kbd></button>
        <button type="button" data-mode="free">Free cam<kbd>F</kbd></button>
        <button type="button" id="specBallCam">Ball cam<kbd>B</kbd></button>
        <button type="button" id="specHelpButton" aria-expanded="false">Help<kbd>?</kbd></button>
        <button type="button" id="specHide">Hide<kbd>H</kbd></button>
        <button type="button" id="specLeave">Leave</button>
      </div>
    </div>`;
  document.body.appendChild(root);
}

async function main(): Promise<void> {
  console.info(`RL-like spectator ${buildLabel()}`);
  document.title = 'Car Soccer Spectator';
  document.body.classList.add('spectator-mode');
  buildOverlay();
  const settings = loadSettings();
  await loadMaskwaArt();
  const arenaGeometry = buildArenaGeometry();
  const probe = await Game.create(FREE_PLAY_CONFIG);
  const app = $('app');
  const renderer = new Renderer(app, arenaGeometry, probe.pads);
  probe.destroy();
  renderer.setQuality(settings.graphics.quality);
  const sound = new SoundManager();
  sound.setVolume(settings.audio.volume);
  sound.setMuted(settings.audio.muted);
  const iceReady = loadIceConfig();

  const hudEl = $('hud');
  const scoreEl = $('score');
  const clockEl = $('clock');
  const bannerEl = $('banner');
  const bannerTitleEl = bannerEl.querySelector('.title') as HTMLElement;
  const bannerSpeedEl = bannerEl.querySelector('.goalSpeed') as HTMLElement;
  const bannerSubEl = bannerEl.querySelector('.sub') as HTMLElement;
  const fpsEl = $('fps');
  const pingEl = $('ping');
  const camModeEl = $('camMode');
  const speedEl = $('speed');
  const speedValueEl = speedEl.querySelector('.value')!;
  const boostFillEl = document.getElementById('boostFill') as unknown as SVGCircleElement;
  const boostValueEl = $('boostValue');
  const bottomRightEl = $('bottomright');
  boostFillEl.style.strokeDasharray = `${GAUGE_CIRCUMFERENCE} ${GAUGE_FULL}`;
  const joinEl = $('specJoin');
  const joinForm = $<HTMLFormElement>('specJoinForm');
  const codeInput = $<HTMLInputElement>('specCode');
  const watchButton = $<HTMLButtonElement>('specWatch');
  const statusEl = $('specStatus');
  const waitEl = $('specWait');
  const barEl = $('specBar');
  const playersEl = $('specPlayers');
  const followEl = $('specFollow');
  const helpEl = $('specHelp');
  const helpButton = $('specHelpButton');
  const ballCamButton = $('specBallCam');
  $('specBuild').textContent = buildLabel();

  let session: SpectatorSession | null = null;
  let mode: Mode = 'overview';
  let followId = -1;
  let ballCam = true;
  let followCam = new FollowCamera(settings);
  const overview = new OverviewCamera();
  const freeCam = new FreeCamera();
  const camera = renderer.camera;

  const dbg = window as unknown as Record<string, unknown>;
  dbg.__renderer = renderer;
  Object.defineProperty(dbg, '__spectator', { get: () => session, configurable: true });
  Object.defineProperty(dbg, '__view', { get: () => ({ mode, followId, ballCam, overview: overview.style }), configurable: true });

  // --- Screens --------------------------------------------------------------------

  const roster = () => ordered(session?.players ?? []);
  const showScreens = () => {
    const watching = !!session;
    const live = !!session?.ready;
    joinEl.hidden = watching;
    waitEl.hidden = !watching || live;
    barEl.hidden = !live;
    if (!watching) setTimeout(() => codeInput.focus(), 0);
    if (watching && !live) {
      $('specWaitCode').textContent = session!.code;
      $('specWaitStatus').textContent = session!.inMatch ? 'Match starting…' : 'Waiting for the host to start the match…';
      const team = (t: Team) => {
        const list = roster().filter((p) => p.team === t);
        return `<div class="lobby-team ${t}"><div class="lobby-team-title">${t.toUpperCase()}</div>${
          list.length ? list.map((p) => `<div class="lobby-player">${escapeHtml(p.name)}</div>`).join('') : '<div class="lobby-player empty">—</div>'}</div>`;
      };
      $('specRoster').innerHTML = team('blue') + team('orange');
    }
    renderPlayerButtons();
  };

  let playerButtonsKey = '';
  const renderPlayerButtons = () => {
    const list = roster();
    const key = JSON.stringify([list.map((p) => [p.slot, p.name, p.team]), mode, followId]);
    if (key === playerButtonsKey) return;
    playerButtonsKey = key;
    playersEl.innerHTML = list.map((p, i) => `<button type="button" class="${p.team}${mode === 'player' && p.slot === followId ? ' active' : ''}" data-slot="${p.slot}">
      <span>${escapeHtml(p.name || `Player ${p.slot + 1}`)}</span><span class="boost" data-boost="${p.slot}"></span><kbd>${i + 1}</kbd></button>`).join('');
    for (const b of barEl.querySelectorAll<HTMLButtonElement>('[data-mode]')) b.classList.toggle('active', b.dataset.mode === mode);
    ballCamButton.classList.toggle('active', ballCam && mode === 'player');
    ballCamButton.hidden = mode !== 'player';
  };

  const setMode = (next: Mode, slot?: number) => {
    if (next === 'free' && mode !== 'free') freeCam.takeOver(camera);
    if (next === 'overview' && mode === 'overview') overview.toggleStyle();
    if (next === 'overview' && mode !== 'overview') overview.reset();
    if (next === 'player') {
      const list = roster();
      if (!list.length) { setMode('overview'); return; }
      const target = slot ?? (list.some((p) => p.slot === followId) ? followId : list[0].slot);
      if (target !== followId || mode !== 'player') {
        followCam = new FollowCamera(settings);
        followCam.ballCam = ballCam;
        resetSoundEdges();
      }
      followId = target;
    }
    mode = next;
    if (mode === 'player') followCam.applyProjection(camera);
    renderPlayerButtons();
  };
  const cyclePlayer = (direction: number) => {
    const list = roster();
    if (!list.length) return;
    const i = list.findIndex((p) => p.slot === followId);
    const next = list[(i < 0 ? 0 : i + direction + list.length) % list.length];
    setMode('player', next.slot);
  };
  const cycleMode = () => setMode(mode === 'overview' ? 'player' : mode === 'player' ? 'free' : 'overview');
  const toggleBallCam = () => {
    if (mode !== 'player') return;
    ballCam = !ballCam;
    followCam.ballCam = ballCam;
    renderPlayerButtons();
  };
  const toggleUi = () => document.body.classList.toggle('ui-hidden');
  const toggleHelp = () => {
    helpEl.hidden = !helpEl.hidden;
    helpButton.setAttribute('aria-expanded', String(!helpEl.hidden));
  };

  // --- Session ----------------------------------------------------------------------

  const leave = (reason = '') => {
    const s = session;
    session = null;
    if (s) { s.onEnded = null; s.leave(); }
    if (document.pointerLockElement) document.exitPointerLock();
    renderer.syncCars([], -1, 0);
    statusEl.textContent = reason;
    hideBanner();
    showScreens();
  };

  const watch = async (raw: string) => {
    const code = normalizeCode(raw);
    if (!code) return;
    leave();
    sound.start(); // user gesture (or the first one after an auto-join link)
    watchButton.disabled = true;
    statusEl.textContent = `Connecting to ${code}…`;
    try {
      await iceReady;
      const s = await SpectatorSession.create(code);
      session = s;
      s.onLobbyChanged = showScreens;
      s.onMatchStarted = () => {
        overview.reset();
        lastScore = '';
        lastPhase = '';
        showScreens();
      };
      s.onEnded = (reason) => { if (session === s) leave(reason); };
      statusEl.textContent = '';
      mode = 'overview';
      overview.reset();
      showScreens();
    } catch (err) {
      statusEl.textContent = `Could not watch: ${describeError(err)}`;
    } finally {
      watchButton.disabled = false;
    }
  };

  joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    void watch(codeInput.value);
  });
  $('specLeave').addEventListener('click', () => leave());
  $('specLeaveWait').addEventListener('click', () => leave());
  $('specHide').addEventListener('click', toggleUi);
  helpButton.addEventListener('click', toggleHelp);
  ballCamButton.addEventListener('click', toggleBallCam);
  barEl.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest('button');
    if (!target) return;
    if (target.dataset.mode) setMode(target.dataset.mode as Mode);
    else if (target.dataset.slot) setMode('player', Number(target.dataset.slot));
    target.blur(); // keep Space/arrows for the camera, not the focused button
  });

  // --- Keyboard, mouse and touch ------------------------------------------------------

  const held = new Set<string>();
  const look = { x: 0, y: 0 };
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    held.add(e.code);
    if (!session?.ready) return;
    const digit = /^Digit([1-8])$/.exec(e.code);
    if (digit) {
      const p = roster()[Number(digit[1]) - 1];
      if (p) setMode('player', p.slot);
      return;
    }
    if (e.repeat) return;
    switch (e.code) {
      case 'KeyO': case 'Digit0': setMode('overview'); break;
      case 'KeyF': setMode('free'); break;
      case 'KeyP': setMode('player'); break;
      case 'Tab': e.preventDefault(); cyclePlayer(e.shiftKey ? -1 : 1); break;
      case 'ArrowRight': if (mode !== 'free') cyclePlayer(1); break;
      case 'ArrowLeft': if (mode !== 'free') cyclePlayer(-1); break;
      case 'KeyB': toggleBallCam(); break;
      case 'KeyC': if (mode === 'player') toggleBallCam(); break;
      case 'KeyH': toggleUi(); break;
      case 'Slash': toggleHelp(); break;
      case 'Space': e.preventDefault(); break;
    }
  });
  window.addEventListener('keyup', (e) => held.delete(e.code));
  window.addEventListener('blur', () => held.clear());
  const canvas = renderer.gl.domElement;
  canvas.style.touchAction = 'none';
  let touchPointer = -1;
  let touchLast = { x: 0, y: 0 };
  canvas.addEventListener('pointerdown', (e) => {
    if (mode !== 'free' || !session?.ready) return;
    if (e.pointerType === 'mouse') {
      if (!document.pointerLockElement) void canvas.requestPointerLock?.();
    } else {
      touchPointer = e.pointerId;
      touchLast = { x: e.clientX, y: e.clientY };
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (document.pointerLockElement === canvas) {
      look.x += e.movementX * LOOK_SENSITIVITY;
      look.y += e.movementY * LOOK_SENSITIVITY;
    } else if (e.pointerId === touchPointer) {
      look.x += (e.clientX - touchLast.x) * LOOK_SENSITIVITY * 1.6;
      look.y += (e.clientY - touchLast.y) * LOOK_SENSITIVITY * 1.6;
      touchLast = { x: e.clientX, y: e.clientY };
    }
  });
  const endTouch = (e: PointerEvent) => { if (e.pointerId === touchPointer) touchPointer = -1; };
  canvas.addEventListener('pointerup', endTouch);
  canvas.addEventListener('pointercancel', endTouch);

  // --- Gamepad ----------------------------------------------------------------------

  const padPrev: boolean[] = [];
  const pad = { moveX: 0, moveZ: 0, moveY: 0, lookX: 0, lookY: 0, fast: false };
  const dz = (v: number) => (Math.abs(v) < DEADZONE ? 0 : (v - Math.sign(v) * DEADZONE) / (1 - DEADZONE));
  const pollGamepad = () => {
    pad.moveX = pad.moveZ = pad.moveY = pad.lookX = pad.lookY = 0;
    pad.fast = false;
    const gp = [...(navigator.getGamepads?.() ?? [])].find((g) => g && g.connected);
    if (!gp) return;
    const pressed = (i: number) => !!gp.buttons[i]?.pressed;
    const edge = (i: number) => {
      const now = pressed(i);
      const was = padPrev[i] ?? false;
      padPrev[i] = now;
      return now && !was;
    };
    if (session?.ready) {
      if (edge(0)) toggleBallCam();
      if (edge(2)) cycleMode();
      if (edge(3)) setMode('overview');
      if (edge(4)) cyclePlayer(-1);
      if (edge(5)) cyclePlayer(1);
      if (edge(9)) toggleUi();
    } else for (let i = 0; i < gp.buttons.length; i++) padPrev[i] = pressed(i);
    pad.moveX = dz(gp.axes[0] ?? 0);
    pad.moveZ = -dz(gp.axes[1] ?? 0);
    pad.lookX = dz(gp.axes[2] ?? 0);
    pad.lookY = dz(gp.axes[3] ?? 0);
    pad.moveY = (gp.buttons[7]?.value ?? 0) - (gp.buttons[6]?.value ?? 0);
    pad.fast = pressed(10);
  };

  const freeInput = (dt: number): FreeCamInput => {
    const k = (...codes: string[]) => (codes.some((c) => held.has(c)) ? 1 : 0);
    const input: FreeCamInput = {
      moveX: k('KeyD', 'ArrowRight') - k('KeyA', 'ArrowLeft') + pad.moveX,
      moveZ: k('KeyW', 'ArrowUp') - k('KeyS', 'ArrowDown') + pad.moveZ,
      moveY: k('Space', 'KeyE') - k('KeyQ', 'ControlLeft', 'ControlRight') + pad.moveY,
      yaw: look.x + pad.lookX * STICK_LOOK_RATE * dt,
      pitch: look.y + pad.lookY * STICK_LOOK_RATE * dt,
      fast: k('ShiftLeft', 'ShiftRight') > 0 || pad.fast,
    };
    look.x = look.y = 0;
    return input;
  };

  // --- HUD ----------------------------------------------------------------------------

  let bannerUntil = 0;
  const showBanner = (title: string, speed: string, sub: string, color: string, ms: number, countdown = false) => {
    bannerTitleEl.textContent = title;
    bannerSpeedEl.textContent = speed;
    bannerSubEl.textContent = sub;
    bannerEl.style.color = color;
    bannerEl.style.display = 'block';
    bannerEl.classList.toggle('countdown', countdown);
    bannerUntil = ms > 0 ? performance.now() + ms : Infinity;
  };
  function hideBanner() {
    bannerEl.style.display = 'none';
    bannerEl.classList.remove('countdown');
    bannerUntil = 0;
  }

  // Sound edges for the followed car.
  let prev = { jumping: false, grounded: true, doubleJumped: false, flipping: false, boosting: false, vy: 0, air: 0 };
  function resetSoundEdges() {
    prev = { jumping: false, grounded: true, doubleJumped: false, flipping: false, boosting: false, vy: 0, air: 0 };
  }

  let last = performance.now();
  let fpsFrames = 0;
  let fpsWindowStart = last;
  let lastScore = '';
  let lastPhase = '';
  let lastCountdown = -1;
  let lastClock = '';
  let lastLive = '';
  let lastBoost = -1;
  let lastSpeed = -1;
  let ballCamBeforeGoal = true;
  let wasGoal = false;
  const boostText = new Map<number, string>();

  const frame = (now: number) => {
    requestAnimationFrame(frame);
    const dt = Math.max(0, Math.min((now - last) / 1000, 0.1));
    last = now;
    pollGamepad();
    const s = session;
    s?.update(dt);
    const game = s?.ready ? s.game : null;
    if (!s || !game) {
      hudEl.hidden = true;
      followEl.hidden = true;
      renderer.setArena(normalizeArena(s?.settings.arena ?? settings.arena.style));
      renderer.renderOverview(dt, true);
      return;
    }
    if (barEl.hidden) showScreens();
    hudEl.hidden = false;
    renderer.setArena(normalizeArena(game.config.arena));

    // Keep the followed player valid as people join, leave or switch teams.
    if (mode === 'player' && !game.cars.has(followId)) {
      const next = roster().find((p) => game.cars.has(p.slot));
      if (next) setMode('player', next.slot);
      else setMode('overview');
    }

    const states = s.carRenderStates();
    renderer.syncCars(states, mode === 'player' ? followId : -1, dt);
    renderer.syncBall(game.prev.ball, game.curr.ball, s.alpha, game.ballVisible, s.ballOffset(), dt, game.ball.linvel());
    renderer.syncPads(game.pads, dt);
    for (const d of s.events.demos) {
      renderer.demoExplosion(d.x, d.y, d.z);
      sound.demolition();
    }

    // Goal pause: no ball to look at, so car cam until kickoff, then back to the viewer's choice.
    const inGoal = game.phase === 'goal';
    if (inGoal && !wasGoal) { ballCamBeforeGoal = ballCam; followCam.ballCam = false; }
    else if (!inGoal && wasGoal) followCam.ballCam = ballCamBeforeGoal;
    wasGoal = inGoal;

    const followed = mode === 'player' ? game.cars.get(followId) ?? null : null;
    const carObj = followed ? renderer.carObject(followId) : null;
    if (followed && carObj) {
      const v = followed.body.linvel();
      followCam.update(camera, carObj, renderer.ballMesh, { grounded: followed.grounded, speed: Math.hypot(v.x, v.y, v.z), supersonic: followed.supersonic }, dt);
    } else if (mode === 'free') freeCam.update(camera, freeInput(dt), dt);
    else overview.update(camera, game.ballVisible ? renderer.ballMesh.position : null, dt);
    renderer.render(dt);

    // --- HUD ---
    const stadiumClock = game.config.matchSeconds > 0
      ? game.overtime ? `+${formatClock(game.overtimeElapsed)}` : formatClock(game.timeRemaining)
      : 'FREE';
    renderer.setScore(game.score.blue, game.score.orange, stadiumClock);
    const clockText = game.config.matchSeconds > 0 ? stadiumClock : '';
    if (clockText !== lastClock) {
      lastClock = clockText;
      clockEl.hidden = clockText === '';
      clockEl.textContent = clockText;
      clockEl.classList.toggle('overtime', game.overtime);
    }
    camModeEl.textContent = mode === 'player' ? (followCam.ballCam ? 'BALL CAM' : 'CAR CAM') : mode === 'free' ? 'FREE CAM' : overview.style === 'broadcast' ? 'BROADCAST' : 'FULL FIELD';
    camModeEl.classList.toggle('on', mode !== 'player' || followCam.ballCam);

    const player = s.players.find((p) => p.slot === followId);
    followEl.hidden = !followed || document.body.classList.contains('ui-hidden');
    if (followed) {
      const label = `${player?.name || `Player ${followId + 1}`}`;
      if (followEl.textContent !== label) followEl.textContent = label;
      followEl.className = `spectator-follow ${followed.team}`;
    }
    bottomRightEl.classList.toggle('hidden-gauges', !followed);
    if (followed) {
      const v = followed.body.linvel();
      const kmh = Math.round((Math.hypot(v.x, v.y, v.z) / UU) * UU_S_TO_KMH);
      if (kmh !== lastSpeed) { lastSpeed = kmh; speedValueEl.textContent = String(kmh); }
      const boost = Math.round(followed.boost);
      if (boost !== lastBoost) {
        lastBoost = boost;
        boostValueEl.textContent = String(boost);
        boostFillEl.style.strokeDashoffset = `${GAUGE_CIRCUMFERENCE * (1 - boost / CAR.boostMax)}`;
      }
      boostFillEl.setAttribute('class', `fill ${followed.boosting ? 'boosting' : boost === 0 ? 'empty' : ''}`);
    }
    for (const [id, car] of game.cars) {
      const text = String(Math.round(car.boost));
      if (boostText.get(id) === text) continue;
      boostText.set(id, text);
      const el = playersEl.querySelector(`[data-boost="${id}"]`);
      if (el) el.textContent = text;
    }
    renderPlayerButtons();

    // Ping and how live the picture is: the newest snapshot's age is covered by extrapolation.
    const age = s.stats.extrapolatedTicks;
    const live = s.ping === null ? 'LIVE' : `LIVE · ${Math.round(s.ping)} ms`;
    if (live + age !== lastLive) {
      lastLive = live + age;
      pingEl.hidden = false;
      pingEl.innerHTML = `<span class="spectator-live${age > 12 ? ' stale' : ''}">${live}</span>`;
    }
    fpsFrames++;
    if (now - fpsWindowStart >= 500) {
      fpsEl.textContent = `${Math.round((fpsFrames * 1000) / (now - fpsWindowStart))} fps`;
      fpsFrames = 0;
      fpsWindowStart = now;
    }

    const scoreText = `${game.score.blue}-${game.score.orange}`;
    const scoreTotal = game.score.blue + game.score.orange;
    const goal = lastScore !== '' && scoreText !== lastScore && scoreTotal > 0;
    if (scoreText !== lastScore) {
      if (goal && game.lastGoal) {
        renderer.goalExplosion(game.lastGoal);
        const scorer = s.players.find((p) => p.slot === game.lastGoalScorer);
        const ownGoal = !!scorer && scorer.team !== game.lastGoal;
        const kmh = Math.round((game.lastGoalSpeed / UU) * UU_S_TO_KMH);
        showBanner(`${game.lastGoal.toUpperCase()} SCORES`, `${kmh} km/h`, scorer ? (ownGoal ? `${scorer.name} (own goal)` : scorer.name) : '', TEAM_COLOR[game.lastGoal], 2500);
      }
      lastScore = scoreText;
      scoreEl.innerHTML = `<span class="blue" aria-label="Blue ${game.score.blue}">${game.score.blue}</span><span class="score-label">CAR SOCCER</span><span class="orange" aria-label="Orange ${game.score.orange}">${game.score.orange}</span>`;
    }
    let countdownSound: 0 | 1 | 2 = 0;
    if (game.phase === 'countdown') {
      const n = Math.ceil(game.countdown);
      if (n !== lastCountdown) { lastCountdown = n; showBanner(String(n), '', '', '#ffffff', 0, true); countdownSound = 1; }
    } else if (lastPhase === 'countdown') {
      lastCountdown = -1;
      showBanner('GO!', '', '', '#7CFC9A', 700, true);
      countdownSound = 2;
    } else if (game.phase === 'over' && lastPhase !== 'over') {
      const winner: Team | null = game.score.blue === game.score.orange ? null : game.score.blue > game.score.orange ? 'blue' : 'orange';
      showBanner(winner ? `${winner.toUpperCase()} WINS` : 'DRAW', `${game.score.blue} – ${game.score.orange}`, '', winner ? TEAM_COLOR[winner] : '#ffffff', 0);
    } else if (game.phase !== 'over' && lastPhase === 'over') hideBanner();
    lastPhase = game.phase;
    if (bannerUntil && now > bannerUntil) hideBanner();

    // Sound: the followed car's engine and moves; ball, goal and countdown for every view.
    const fv = followed?.body.linvel();
    const grounded = followed?.grounded ?? true;
    const landed = !!followed && grounded && !prev.grounded && prev.air > 0.25;
    sound.update({
      speedUU: fv ? Math.hypot(fv.x, fv.y, fv.z) / UU : 0,
      throttle: followed?.lastInput.throttle ?? 0,
      boosting: followed?.boosting ?? false,
      boostStarted: !!followed?.boosting && !prev.boosting,
      grounded,
      supersonic: followed?.supersonic ?? false,
      jumped: !!followed?.isJumping && !prev.jumping,
      doubleJumped: !!followed?.doubleJumped && !prev.doubleJumped,
      dodged: !!followed?.isFlipping && !prev.flipping,
      landedSpeedUU: landed ? Math.max(200, -prev.vy / UU) : 0,
      skid: 0,
      padCollected: 0,
      carBumpSpeedUU: 0,
      ballHitSpeedUU: s.events.ballHitSpeed / UU,
      ballBounceSpeedUU: s.events.ballBounceSpeed / UU,
      goal,
      wallHitSpeedUU: 0,
      countdown: countdownSound,
      ballDistance: camera.position.distanceTo(renderer.ballMesh.position),
    });
    prev = {
      jumping: followed?.isJumping ?? false, grounded, doubleJumped: followed?.doubleJumped ?? false,
      flipping: followed?.isFlipping ?? false, boosting: followed?.boosting ?? false, vy: fv?.y ?? 0,
      air: grounded ? 0 : prev.air + dt,
    };
  };

  showScreens();
  requestAnimationFrame(frame);
  const linked = new URLSearchParams(location.search).get('room');
  if (linked) {
    codeInput.value = normalizeCode(linked);
    void watch(linked);
  }
}

export const ready = main().catch((err) => {
  console.error(err);
  const status = document.getElementById('specStatus');
  if (status) status.textContent = `Failed to start: ${String(err)}`;
  throw err;
});
