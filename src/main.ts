import { CAR, UU } from './sim/rl';
import { buildArenaGeometry } from './sim/arena';
import { FREE_PLAY_CONFIG, Game, type Team } from './sim/game';
import { Renderer } from './render/renderer';
import { FollowCamera } from './render/camera';
import { InputManager } from './input/input';
import { EMPTY_INPUT } from './input/types';
import { MATCH_LENGTHS, Menu, type MenuContext } from './ui/menu';
import { SoundManager } from './audio/sound';
import { loadSettings, saveSettings } from './settings';
import { buildLabel } from './build';
import { LocalSession, type Session } from './net/session';
import { HostSession } from './net/host';
import { ClientSession } from './net/client';
import { describeError, loadIceConfig, testConnectivity, turnConfigured } from './net/transport';

const app = document.getElementById('app')!;
const hudEl = document.getElementById('hud')!;
const scoreEl = document.getElementById('score')!;
const clockEl = document.getElementById('clock')!;
const bannerEl = document.getElementById('banner')!;
const bannerTitleEl = bannerEl.querySelector('.title') as HTMLElement;
const bannerSpeedEl = bannerEl.querySelector('.goalSpeed') as HTMLElement;
const bannerSubEl = bannerEl.querySelector('.sub') as HTMLElement;
const fpsEl = document.getElementById('fps')!;
const camModeEl = document.getElementById('camMode')!;
const pingEl = document.getElementById('ping')!;
const controllerEl = document.getElementById('controller')!;
const speedEl = document.getElementById('speed')!;
const speedValueEl = speedEl.querySelector('.value')!;
const boostFillEl = document.getElementById('boostFill') as unknown as SVGCircleElement;
const boostValueEl = document.getElementById('boostValue')!;

const GAUGE_CIRCUMFERENCE = 2 * Math.PI * 56;
boostFillEl.style.strokeDasharray = `${GAUGE_CIRCUMFERENCE}`;
/** uu/s -> km/h (1 uu = 1 cm). */
const UU_S_TO_KMH = 0.036;
/** Speed readout goes red only at the hard cap (within 10 uu/s of 2300, shown in km/h). */
const MAX_SPEED_KMH = (CAR.maxSpeed / UU - 10) * UU_S_TO_KMH;
const TEAM_COLOR: Record<Team, string> = { blue: '#4aa3ff', orange: '#ff9a3c' };

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

function setController(name: string | null): void {
  controllerEl.innerHTML = name
    ? `<span class="ok">Controller: ${escapeHtml(name)}</span>`
    : `<span class="warn">No controller.</span> Press a button on your controller, or use the keyboard.`;
}

function setCamMode(ballCam: boolean): void {
  camModeEl.textContent = ballCam ? 'BALL CAM' : 'CAR CAM';
  camModeEl.classList.toggle('on', ballCam);
}

function formatClock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

async function main(): Promise<void> {
  console.info(`RL-like ${buildLabel()}`);
  const settings = loadSettings();
  // The arena is static: build its geometry once for the renderer, independent of any game.
  const arenaGeometry = buildArenaGeometry();
  const probe = await Game.create(FREE_PLAY_CONFIG); // also initialises the physics engine
  const renderer = new Renderer(app, arenaGeometry, probe.pads);
  probe.destroy();
  const followCam = new FollowCamera(settings);
  const input = new InputManager(settings);
  const menu = new Menu(document.body, input, settings);
  const sound = new SoundManager();
  // Relay credentials, if the deployment has any. Never blocks startup.
  const iceReady = loadIceConfig();

  let session: Session | null = null;

  // Debug handles for the browser console.
  const dbg = window as unknown as Record<string, unknown>;
  dbg.__input = input;
  dbg.__menu = menu;
  dbg.__renderer = renderer;
  dbg.__camera = followCam;
  dbg.__sound = sound;
  Object.defineProperty(dbg, '__session', { get: () => session, configurable: true });
  Object.defineProperty(dbg, '__game', { get: () => session?.game ?? null, configurable: true });

  const applySettings = () => {
    saveSettings(settings);
    followCam.applyProjection(renderer.camera);
    renderer.setQuality(settings.graphics.quality);
    sound.setVolume(settings.audio.volume);
    const localCar = session?.game?.cars.get(session.localId);
    if (localCar) localCar.dodgeDeadzone = settings.controls.dodgeDeadzone;
    if (session instanceof HostSession) {
      session.hostDodgeDeadzone = settings.controls.dodgeDeadzone;
      session.game?.setDodgeDeadzone(0, settings.controls.dodgeDeadzone);
    }
    // Car body: cosmetic, so it can change at any time; online it reaches everyone via the lobby.
    if (session instanceof LocalSession) session.body = settings.car.body;
    else if (session instanceof HostSession) session.setHostBody(settings.car.body);
    else if (session instanceof ClientSession) session.setBody(settings.car.body);
  };
  applySettings();
  window.addEventListener('resize', () => followCam.applyProjection(renderer.camera));

  let controllerName: string | null = null;
  input.onControllerChange = (name) => {
    controllerName = name;
    setController(name);
  };
  setController(null);
  setCamMode(followCam.ballCam);

  // --- Session management --------------------------------------------------------

  const menuContext = (): MenuContext => {
    if (!session) return { kind: 'none' };
    if (session.kind === 'local') return { kind: 'local' };
    return { kind: session.kind, inMatch: !!session.lobby?.inMatch };
  };
  const refreshMenu = () => {
    menu.setContext(menuContext());
    menu.setLobby(session?.lobby ?? null);
  };

  const attach = (s: Session) => {
    session = s;
    s.onLobbyChanged = refreshMenu;
    s.onMatchStarted = () => {
      refreshMenu();
      resetFrameTimers();
      menu.play();
    };
    s.onEnded = (reason) => {
      if (session === s) session = null;
      renderer.syncCars([], -1, 0);
      refreshMenu();
      menu.setMultiplayerStatus(reason);
      menu.show('multiplayer');
    };
    refreshMenu();
    applySettings();
  };

  const endSession = () => {
    const s = session;
    session = null;
    if (s) {
      s.onEnded = null;
      s.leave();
    }
    renderer.syncCars([], -1, 0);
    refreshMenu();
  };

  menu.onFreePlay = async () => {
    endSession();
    attach(await LocalSession.create());
    resetFrameTimers();
    menu.play();
  };
  menu.onQuit = () => {
    endSession();
    menu.show('main');
  };
  menu.onHost = async (name) => {
    endSession();
    menu.setMultiplayerStatus('Creating room…', true);
    try {
      await iceReady;
      const host = await HostSession.create(name);
      host.hostDodgeDeadzone = settings.controls.dodgeDeadzone;
      attach(host);
      menu.setMultiplayerStatus('');
      menu.show('lobby');
    } catch (err) {
      menu.setMultiplayerStatus(`Could not create a room: ${describeError(err)}`);
    }
  };
  menu.onJoin = async (name, code) => {
    endSession();
    menu.setMultiplayerStatus(`Joining ${code}…`, true);
    try {
      await iceReady;
      const client = await ClientSession.create(code, name, settings.controls.dodgeDeadzone, settings.car.body);
      attach(client);
      menu.setMultiplayerStatus('');
      menu.show('lobby');
    } catch (err) {
      menu.setMultiplayerStatus(`Could not join: ${describeError(err)}`);
    }
  };
  menu.onLeaveRoom = () => {
    endSession();
    menu.setMultiplayerStatus('');
    menu.show('multiplayer');
  };
  menu.onSwitchTeam = () => {
    if (session instanceof HostSession) session.setHostTeam(session.hostTeam === 'blue' ? 'orange' : 'blue');
    else if (session instanceof ClientSession) {
      const me = session.lobby.players.find((p) => p.slot === session!.localId);
      session.requestTeam(me?.team === 'blue' ? 'orange' : 'blue');
    }
  };
  menu.onCycleMatchLength = () => {
    if (!(session instanceof HostSession)) return;
    const i = MATCH_LENGTHS.indexOf(session.settings.matchSeconds);
    session.setSettings({ matchSeconds: MATCH_LENGTHS[(i + 1) % MATCH_LENGTHS.length] });
  };
  menu.onStartMatch = () => {
    if (session instanceof HostSession) void session.startMatch();
  };
  menu.onEndMatch = () => {
    if (session instanceof HostSession) {
      session.endMatch();
      refreshMenu();
      menu.show('lobby');
    }
  };
  /**
   * Report what this network allows. `host` means a direct path on this machine or LAN, `srflx`
   * means the public address found through STUN, `relay` means a TURN relay answered. Two players
   * on different home networks usually need a relay.
   */
  menu.onTestConnection = async () => {
    await iceReady;
    menu.setConnectionReport('Testing…');
    const direct = await testConnectivity(false);
    const relay = await testConnectivity(true);
    const has = (t: string) => direct.candidateTypes.includes(t);
    const lines = [
      `Direct (same machine or LAN):  ${has('host') ? 'yes' : 'no'}`,
      `Public address via STUN:       ${has('srflx') ? 'yes' : 'no'}`,
      `Relay configured:              ${turnConfigured() ? 'yes' : 'no'}`,
      `Relay reachable:               ${relay.candidateTypes.includes('relay') ? 'yes' : 'no'}`,
    ];
    if (!turnConfigured()) {
      lines.push('', 'No relay is set up, so you can only play with someone', 'whose network allows a direct connection. Add one in', 'public/turn.json to make every network work.');
    } else if (!relay.candidateTypes.includes('relay')) {
      lines.push('', 'The relay did not answer. Check the credentials in', 'public/turn.json (they may have expired).');
    } else {
      lines.push('', 'Ready: connections will fall back to the relay when', 'a direct path is not possible.');
    }
    if (relay.errors.length) lines.push('', `ICE notes: ${relay.errors.slice(0, 2).join(' | ')}`);
    menu.setConnectionReport(lines.join('\n'));
  };

  menu.onSettingsChanged = applySettings;
  menu.onPlay = () => {
    resetFrameTimers();
    input.blockJumpUntilRelease();
    sound.start(); // user gesture: safe to create the AudioContext
    if (session instanceof LocalSession) session.resume();
  };

  // --- Background ticking ----------------------------------------------------------
  // A hidden tab gets requestAnimationFrame and timers throttled to about once a second, which
  // would freeze a hosted match for everyone. Worker timers are not throttled, so a tiny worker
  // pings the page every few milliseconds and, whenever the frame loop has not run for a while
  // (hidden tab, minimised window, or any other stall), the network session is advanced from
  // those pings instead (no rendering). Both paths draw their time from the same clock,
  // `lastSessionUpdate`, so running both can never count the same wall time twice.
  let lastSessionUpdate = performance.now();
  let lastFrameAt = performance.now();
  const sessionDt = (now: number): number => {
    const dt = Math.max(0, Math.min((now - lastSessionUpdate) / 1000, 0.1));
    lastSessionUpdate = now;
    return dt;
  };
  try {
    const src = 'setInterval(() => postMessage(0), 4);';
    const worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    worker.onmessage = () => {
      if (!session || session.kind === 'local') return;
      const now = performance.now();
      if (now - lastFrameAt < 50) return; // the frame loop is doing its job
      session.update(EMPTY_INPUT, sessionDt(now), true);
      last = now; // the frame loop resumes from here when frames come back
    };
  } catch {
    /* no worker: the tab must stay visible to host */
  }

  // --- Frame loop ------------------------------------------------------------------

  let lastScore = '';
  let bannerUntil = 0;
  let last = performance.now();
  let fpsFrames = 0;
  let fpsWindowStart = performance.now();
  let lastSpeedKmh = -1;
  let lastBoost = -1;
  let lastBoostState = '';
  let lastClock = '';
  let lastPingText = '';
  let ballCamBeforeGoal = followCam.ballCam;
  let wasInGoalPause = false;
  let lastPhase = '';
  let lastCountdownNumber = -1;
  // Sound event tracking (frame-level edges).
  let prevJumping = false;
  let prevGrounded = true;
  let prevDoubleJumped = false;
  let prevFlipping = false;
  let prevBoosting = false;
  let prevVy = 0;
  let airTime = 0;
  let prevWorldContact = false;
  let prevPadCooldowns: number[] = [];
  let prevScoreTotal = 0;
  let countdownSound: 0 | 1 | 2 = 0;

  const resetFrameTimers = () => {
    last = performance.now();
    lastSessionUpdate = last;
  };

  const showBanner = (title: string, speed: string, sub: string, color: string, ms: number) => {
    bannerTitleEl.textContent = title;
    bannerSpeedEl.textContent = speed;
    bannerSubEl.textContent = sub;
    bannerEl.style.color = color;
    bannerEl.style.display = 'block';
    bannerEl.classList.remove('countdown');
    bannerUntil = ms > 0 ? performance.now() + ms : Infinity;
  };
  const hideBanner = () => {
    bannerEl.style.display = 'none';
    bannerEl.classList.remove('countdown');
    bannerUntil = 0;
  };

  /** One frame of input, simulation, rendering and HUD. `frame` schedules it; `__step` runs it by hand. */
  const tick = (now: number): void => {
    const frameDt = Math.max(0, Math.min((now - last) / 1000, 0.1));
    last = now;
    lastFrameAt = now;

    const fi = input.poll();
    if (fi.controllerName !== controllerName) {
      controllerName = fi.controllerName;
      setController(controllerName);
    }
    if (fi.menuPressed) menu.toggle();
    if (menu.open) menu.navigate(fi.nav, frameDt);

    // Networked sessions keep running behind the menu; free play pauses.
    session?.update(menu.open ? EMPTY_INPUT : fi.car, sessionDt(now), menu.open);

    if (menu.screen === 'garage') {
      const me = session?.lobby?.players.find((p) => p.slot === session!.localId);
      renderer.renderGarage(settings.car.body, me?.team ?? 'blue', frameDt);
    }

    const game = session?.game ?? null;
    const localCar = game?.cars.get(session!.localId) ?? null;
    if (menu.open || !session || !game || !localCar) {
      hudEl.hidden = true;
      return;
    }
    hudEl.hidden = false;
    const s = session;

    if (fi.resetPressed) s.resetMatch();
    if (fi.toggleCameraPressed) {
      followCam.toggle();
      setCamMode(followCam.ballCam);
      if (game.phase === 'goal') ballCamBeforeGoal = followCam.ballCam; // user's choice during the pause sticks
    }

    // Goal: no ball to look at, so car cam until kickoff, then back to what the player had.
    const inGoalPause = game.phase === 'goal';
    if (inGoalPause && !wasInGoalPause) {
      ballCamBeforeGoal = followCam.ballCam;
      followCam.ballCam = false;
      setCamMode(false);
    } else if (!inGoalPause && wasInGoalPause) {
      followCam.ballCam = ballCamBeforeGoal;
      setCamMode(followCam.ballCam);
    }
    wasInGoalPause = inGoalPause;

    // --- Render ----------------------------------------------------------------------
    const carStates = s.carRenderStates();
    renderer.syncCars(carStates, s.localId, frameDt);
    renderer.syncBall(game.prev.ball, game.curr.ball, s.alpha, game.ballVisible, s.ballOffset(), frameDt, game.ball.linvel());
    renderer.syncPads(game.pads, frameDt);
    const carObj = renderer.carObject(s.localId);
    if (carObj) {
      const lvCam = localCar.body.linvel();
      followCam.update(renderer.camera, carObj, renderer.ballMesh, { grounded: localCar.grounded, speed: Math.hypot(lvCam.x, lvCam.y, lvCam.z), supersonic: localCar.supersonic }, frameDt);
      renderer.render(frameDt);
    }

    // --- Sound events from state edges -------------------------------------------------
    const lvNow = localCar.body.linvel();
    const grounded = localCar.grounded;
    const jumped = localCar.isJumping && !prevJumping;
    const landed = grounded && !prevGrounded && airTime > 0.25;
    const landedSpeedUU = landed ? Math.max(200, -prevVy / UU) : 0;
    airTime = grounded ? 0 : airTime + frameDt;
    const doubleJumped = localCar.doubleJumped && !prevDoubleJumped;
    const dodged = localCar.isFlipping && !prevFlipping;
    // Tyre slip: sideways speed on the ground, boosted by the powerslide.
    const cq = carObj ? carObj.quaternion : null;
    let skid = 0;
    if (grounded && cq) {
      const rx = 1 - 2 * (cq.y * cq.y + cq.z * cq.z);
      const ry = 2 * (cq.x * cq.y + cq.w * cq.z);
      const rz = 2 * (cq.x * cq.z - cq.w * cq.y);
      const lateral = Math.abs(lvNow.x * rx + lvNow.y * ry + lvNow.z * rz);
      skid = Math.min(1, lateral / 6) * (0.35 + 0.65 * localCar.handbrakeVal);
      if (lateral < 1.5) skid *= lateral / 1.5;
    }
    let padCollected: 0 | 1 | 2 = 0;
    if (prevPadCooldowns.length !== game.pads.length) prevPadCooldowns = game.pads.map((p) => p.cooldown);
    for (let i = 0; i < game.pads.length; i++) {
      // Only pads near the local car ring for it (others' pickups are silent).
      if (prevPadCooldowns[i] === 0 && game.pads[i].cooldown > 0) {
        const t = localCar.body.translation();
        if (Math.hypot(t.x - game.pads[i].x, t.z - game.pads[i].z) < 3) padCollected = game.pads[i].big ? 2 : 1;
      }
      prevPadCooldowns[i] = game.pads[i].cooldown;
    }
    // Demolitions: burst, sound and a hard rumble for whoever was hit.
    for (const d of game.demosThisTick) {
      renderer.demoExplosion(d.x, d.y, d.z);
      sound.demolition();
      if (d.victim === s.localId) input.rumble(1, 1, 500);
      else if (d.attacker === s.localId) input.rumble(0.7, 0.5, 250);
    }
    for (const b of game.bumpsThisTick) {
      if (b.a === s.localId || b.b === s.localId) input.rumble(Math.min(1, b.speed / UU / 2000), 0.3, 110);
    }

    const scoreTotal = game.score.blue + game.score.orange;
    const wallHit = localCar.worldContact && !prevWorldContact ? Math.hypot(lvNow.x, lvNow.y, lvNow.z) / UU : 0;
    sound.update({
      speedUU: Math.hypot(lvNow.x, lvNow.y, lvNow.z) / UU,
      throttle: fi.car.throttle,
      boosting: localCar.boosting,
      boostStarted: localCar.boosting && !prevBoosting,
      grounded,
      supersonic: localCar.supersonic,
      jumped,
      doubleJumped,
      dodged,
      landedSpeedUU,
      skid,
      padCollected,
      carBumpSpeedUU: game.bumpsThisTick.length ? game.bumpsThisTick[0].speed / UU : 0,
      ballHitSpeedUU: game.ballHitRelSpeed / UU,
      ballBounceSpeedUU: game.ballBounceDeltaV / UU,
      goal: scoreTotal > prevScoreTotal,
      wallHitSpeedUU: wallHit,
      countdown: countdownSound,
      ballDistance: renderer.camera.position.distanceTo(renderer.ballMesh.position),
    });
    // Controller rumble on the same edges.
    if (landedSpeedUU > 0) input.rumble(Math.min(1, landedSpeedUU / 1200), 0.2, 90);
    if (game.ballHitRelSpeed > 0 && game.lastTouch === s.localId) input.rumble(Math.min(1, game.ballHitRelSpeed / UU / 2500), 0.4, 120);
    if (wallHit > 300) input.rumble(Math.min(1, wallHit / 2300), 0.3, 100);
    if (dodged) input.rumble(0.2, 0.5, 70);
    if (localCar.boosting && Math.floor(now / 90) !== Math.floor((now - frameDt * 1000) / 90)) input.rumble(0, 0.12, 100);
    if (scoreTotal > prevScoreTotal) input.rumble(0.9, 0.9, 450);
    countdownSound = 0;
    prevJumping = localCar.isJumping;
    prevGrounded = grounded;
    prevDoubleJumped = localCar.doubleJumped;
    prevFlipping = localCar.isFlipping;
    prevBoosting = localCar.boosting;
    prevVy = lvNow.y;
    prevWorldContact = localCar.worldContact;
    prevScoreTotal = scoreTotal;

    // --- HUD ---------------------------------------------------------------------------
    const speedKmh = Math.round((Math.hypot(lvNow.x, lvNow.y, lvNow.z) / UU) * UU_S_TO_KMH);
    if (speedKmh !== lastSpeedKmh) {
      lastSpeedKmh = speedKmh;
      speedValueEl.textContent = String(speedKmh);
      speedEl.classList.toggle('max', speedKmh >= MAX_SPEED_KMH);
    }

    const boost = Math.round(localCar.boost);
    if (boost !== lastBoost) {
      lastBoost = boost;
      boostValueEl.textContent = String(boost);
      boostFillEl.style.strokeDashoffset = `${GAUGE_CIRCUMFERENCE * (1 - boost / CAR.boostMax)}`;
    }
    const boostState = localCar.boosting ? 'boosting' : boost === 0 ? 'empty' : '';
    if (boostState !== lastBoostState) {
      lastBoostState = boostState;
      boostFillEl.setAttribute('class', `fill ${boostState}`);
    }

    fpsFrames++;
    if (now - fpsWindowStart >= 500) {
      fpsEl.textContent = `${Math.round((fpsFrames * 1000) / (now - fpsWindowStart))} fps`;
      fpsFrames = 0;
      fpsWindowStart = now;
    }

    // Clock.
    let clockText = '';
    if (game.config.matchSeconds > 0) clockText = game.overtime ? `+${formatClock(game.overtimeElapsed)}` : formatClock(game.timeRemaining);
    if (clockText !== lastClock) {
      lastClock = clockText;
      clockEl.hidden = clockText === '';
      clockEl.textContent = clockText;
      clockEl.classList.toggle('overtime', game.overtime);
    }

    // Ping.
    const pingText = s.ping === null ? '' : `${Math.round(s.ping)} ms`;
    if (pingText !== lastPingText) {
      lastPingText = pingText;
      pingEl.hidden = pingText === '';
      pingEl.textContent = pingText;
      pingEl.classList.toggle('bad', s.ping !== null && s.ping > 150);
    }

    // Score and goal banner.
    const scoreText = `${game.score.blue}-${game.score.orange}`;
    if (scoreText !== lastScore) {
      lastScore = scoreText;
      scoreEl.innerHTML = `<span class="blue">BLUE ${game.score.blue}</span> &nbsp;–&nbsp; <span class="orange">${game.score.orange} ORANGE</span>`;
      if (game.lastGoal && scoreTotal > 0) {
        renderer.goalExplosion(game.lastGoal);
        const kmh = Math.round((game.lastGoalSpeed / UU) * UU_S_TO_KMH);
        const mine = game.lastGoalScorer === s.localId;
        const scorer = carStates.find((c) => c.id === game.lastGoalScorer)?.name ?? '';
        const ownGoal = game.lastGoalScorer >= 0 && carStates.find((c) => c.id === game.lastGoalScorer)?.team !== game.lastGoal;
        const title = mine ? (ownGoal ? 'OWN GOAL' : 'GOAL!') : `${game.lastGoal.toUpperCase()} SCORES`;
        const sub = !mine && scorer ? (ownGoal ? `${scorer} (own goal)` : scorer) : '';
        showBanner(title, `${kmh} km/h`, sub, TEAM_COLOR[game.lastGoal], 2500);
      }
    }

    // Kickoff countdown and match end.
    if (game.phase === 'countdown') {
      const n = Math.ceil(game.countdown);
      if (n !== lastCountdownNumber) {
        lastCountdownNumber = n;
        showBanner(String(n), '', '', '#ffffff', 0);
        bannerEl.classList.add('countdown');
        countdownSound = 1;
      }
    } else if (lastPhase === 'countdown') {
      lastCountdownNumber = -1;
      showBanner('GO!', '', '', '#7CFC9A', 700);
      bannerEl.classList.add('countdown');
      countdownSound = 2;
    } else if (game.phase === 'over' && lastPhase !== 'over') {
      const winner: Team | null = game.score.blue === game.score.orange ? null : game.score.blue > game.score.orange ? 'blue' : 'orange';
      const myTeam = localCar.team;
      const title = winner === null ? 'DRAW' : winner === myTeam ? 'VICTORY' : 'DEFEAT';
      const sub = s.kind === 'host' ? 'Open the menu to return to the lobby' : winner ? `${winner.toUpperCase()} wins` : '';
      showBanner(title, `${game.score.blue} – ${game.score.orange}`, sub, winner ? TEAM_COLOR[winner] : '#ffffff', 0);
    } else if (game.phase !== 'over' && lastPhase === 'over') {
      hideBanner();
    }
    lastPhase = game.phase;
    if (bannerUntil && now > bannerUntil) hideBanner();
  };
  const frame = (now: number): void => {
    tick(now);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  dbg.__step = tick;
}

main().catch((err) => {
  console.error(err);
  controllerEl.innerHTML = `<span class="warn">Failed to start: ${escapeHtml(String(err))}</span>`;
});
