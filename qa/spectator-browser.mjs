// Built-app browser check: real PeerJS/WebRTC LAN host on the game origin, spectator on the
// spectator origin (separate browser context = separate cookies). Ephemeral password only.
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
import { spawn } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';

const root = fileURLToPath(new URL('..', import.meta.url));
const evidence = fileURLToPath(new URL('../.qa-build/spectator-browser', import.meta.url));
await mkdir(evidence, { recursive: true });
const password = randomBytes(24).toString('base64url'), salt = randomBytes(16);
const hash = `${salt.toString('hex')}:${scryptSync(password, salt, 64).toString('hex')}`;
const GAME = 'http://127.0.0.1:4100', SPEC = 'http://localhost:4100';
const server = spawn(process.execPath, ['.server-build/index.js'], { cwd: root, env: { ...process.env, CAR_ORIGIN: GAME, CAR_SPECTATOR_ORIGIN: SPEC, CAR_PASSWORD_HASH: hash, PORT: '4100' }, stdio: ['ignore', 'ignore', 'pipe'] });
server.stderr.on('data', () => {});
const report = { scope: 'Built app on localhost; real PeerJS signalling and WebRTC between a host, desktop viewer and touch-enabled viewer on one Mac; software-rendered WebGL. Not a physical-LAN, multi-device or rendered-performance claim.', checks: [], measurements: {} };
const check = (ok, d) => { if (!ok) throw Error(d); report.checks.push(d); console.log('PASS ' + d); };
const lowQuality = () => localStorage.setItem('rl-like-settings', JSON.stringify({ graphics: { quality: 0 }, audio: { volume: 0, muted: true } }));
let browser;
// Software WebGL in two headless contexts starves the main thread; draw only for screenshots.
const pauseRender = () => {
  const wait = setInterval(() => {
    const r = window.__renderer; if (!r) return; clearInterval(wait);
    const render = r.render.bind(r), overview = r.renderOverview.bind(r);
    window.__qaDraw = false;
    r.render = (dt) => { if (window.__qaDraw) render(dt); };
    r.renderOverview = (dt, o) => { if (window.__qaDraw) overview(dt, o); };
  }, 5);
};
const shot = async (page, name) => { await page.evaluate(() => { window.__qaDraw = true; }); await page.waitForTimeout(700); await page.screenshot({ path: `${evidence}/${name}` }); await page.evaluate(() => { window.__qaDraw = false; }); };
try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(GAME + '/healthz')).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  browser = await chromium.launch({ headless: true, args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--use-gl=angle', '--use-angle=swiftshader'] });
  const hostCtx = await browser.newContext({ viewport: { width: 960, height: 600 } });
  const specCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  for (const c of [hostCtx, specCtx]) { await c.addInitScript(lowQuality); await c.addInitScript(pauseRender); }
  const host = await hostCtx.newPage(), spec = await specCtx.newPage();
  for (const [n, p] of [['host', host], ['spectator', spec]]) p.on('console', m => { if (!m.text().includes('GL Driver')) console.log(`console ${m.type()} (${n}) ${m.text().slice(0, 300)}`); });
  for (const [n, p] of [['host', host], ['spectator', spec]]) p.on('pageerror', e => { console.log(`PAGE ERROR (${n}) ${e.message}`); report.pageErrors = [...(report.pageErrors ?? []), `${n}: ${e.message}`]; });

  await host.goto(GAME, { waitUntil: 'domcontentloaded' });
  await host.getByLabel('Game password').fill(password);
  await host.getByRole('button', { name: 'Log in' }).dispatchEvent('click');
  await host.waitForFunction(() => !!window.__menu, null, { timeout: 40000 });
  await host.evaluate(() => window.__menu.onHost('Host QA'));
  await host.waitForFunction(() => window.__session?.code, null, { timeout: 40000 });
  const code = await host.evaluate(() => window.__session.code);
  check(/^[A-Z2-9]{5}$/.test(code), `LAN host room created (${code})`);
  check(await host.getByText('Spectators can watch with this code at carspectator.spatterson.ca').isVisible(), 'host lobby shows the spectator hint');

  await spec.goto(`${SPEC}/?spectate&room=${code}`, { waitUntil: 'domcontentloaded' });
  check(await spec.getByRole('heading', { name: 'Log into Car Soccer Spectator' }).isVisible(), 'spectator host shows spectator login');
  await spec.getByLabel('Game password').fill(password);
  await spec.getByRole('button', { name: 'Log in' }).dispatchEvent('click');
  await spec.waitForFunction(() => window.__spectator && !document.getElementById('specWait').hidden, null, { timeout: 40000 });
  check(true, 'spectator joined over WebRTC from the room link and waits for kickoff');
  await host.waitForFunction(() => window.__session.lobby.spectators === 1, null, { timeout: 10000 });
  check(await host.getByText('1 watching', { exact: false }).isVisible(), 'host lobby counts 1 watching');
  check(await host.evaluate(() => window.__session.lobby.players.length) === 1, 'spectator took no player slot');
  await shot(spec, '01-waiting.png');

  await host.evaluate(() => window.__menu.onStartMatch());
  await spec.waitForFunction(() => window.__spectator?.ready, null, { timeout: 20000 });
  check(true, 'spectator synchronized when the host started');
  await host.waitForFunction(() => window.__game?.phase === 'play', null, { timeout: 15000 });
  await host.locator('canvas').click({ position: { x: 480, y: 300 } }).catch(() => {});
  await host.keyboard.down('KeyW'); await host.keyboard.down('KeyD');
  await spec.waitForTimeout(1500);

  // Live-ness: sample both ticks against wall clock in the same browser process.
  const samples = [];
  for (let i = 0; i < 20; i++) {
    const [h, s] = await Promise.all([
      host.evaluate(() => ({ tick: window.__game.tick - 1 + window.__session.alpha, at: performance.timeOrigin + performance.now() })),
      spec.evaluate(() => ({ tick: window.__spectator.game.tick - 1 + window.__spectator.alpha, at: performance.timeOrigin + performance.now(), ping: window.__spectator.ping, stats: { ...window.__spectator.stats } })),
    ]);
    samples.push({ lagTicks: (h.tick + (s.at - h.at) * 0.12) - s.tick, ping: s.ping, stats: s.stats });
    await spec.waitForTimeout(100);
  }
  const lags = samples.map(x => x.lagTicks).sort((a, b) => a - b);
  report.measurements.lagTicksMedian = lags[10]; report.measurements.lagTicksMax = lags.at(-1);
  report.measurements.pingMs = samples.at(-1).ping; report.measurements.spectatorStats = samples.at(-1).stats;
  console.log('Measurements', JSON.stringify(report.measurements));
  check(Math.abs(lags[10]) < 6, `spectator picture within 6 ticks (50 ms) of the host on median (${lags[10].toFixed(1)} ticks)`);
  const carMoved = await spec.evaluate(() => { const c = window.__spectator.game.cars.get(0).body.translation(); return Math.hypot(c.x, c.z); });
  check(carMoved > 3, 'spectator sees the host car drive');

  const view = () => spec.evaluate(() => window.__view);
  const camPos = () => spec.evaluate(() => window.__renderer.camera.position.toArray());
  await shot(spec, '02-broadcast.png');
  check((await view()).mode === 'overview' && (await view()).overview === 'broadcast', 'overview broadcast camera is the default');
  check(await spec.evaluate(() => {
    const before = window.__renderer.camera.fov;
    window.dispatchEvent(new Event('resize'));
    return Math.abs(window.__renderer.camera.fov - before) < 1e-6;
  }), 'resize leaves the overview camera projection under overview control');
  await spec.keyboard.press('KeyO'); await spec.waitForTimeout(600);
  check((await view()).overview === 'field', 'O toggles to the full-field overview');
  await shot(spec, '03-full-field.png');
  await spec.keyboard.press('Digit1'); await spec.waitForTimeout(800);
  check((await view()).mode === 'player' && (await view()).followId === 0, '1 follows the first player');
  check(await spec.locator('#specFollow').innerText() === 'Host QA', 'followed player name shown');
  // The renderer changes aspect first; the active chase camera must retain its horizontal FOV.
  const horizontalFov = () => spec.evaluate(() => {
    const c = window.__renderer.camera;
    return 2 * Math.atan(Math.tan(c.fov * Math.PI / 360) * c.aspect) * 180 / Math.PI;
  });
  const chaseFov = await horizontalFov();
  await spec.setViewportSize({ width: 720, height: 1280 });
  await spec.waitForFunction(() => window.__renderer.camera.aspect < 1);
  const portraitFov = await horizontalFov();
  check(Math.abs(portraitFov - chaseFov) < .1, 'player view preserves horizontal FOV on portrait rotation without reselecting');
  await spec.setViewportSize({ width: 1280, height: 720 });
  await spec.waitForFunction(() => window.__renderer.camera.aspect > 1);
  check(Math.abs(await horizontalFov() - chaseFov) < .1, 'player view preserves horizontal FOV when rotated back to landscape');
  report.measurements.resizeFov = { landscape: chaseFov, portrait: portraitFov };
  await shot(spec, '04-player-ballcam.png');
  await spec.keyboard.press('KeyB'); await spec.waitForTimeout(600);
  await spec.waitForFunction(() => document.getElementById('camMode').textContent === 'CAR CAM', null, { timeout: 10000 }).catch(() => {});
  check((await view()).ballCam === false && (await spec.locator('#camMode').innerText()) === 'CAR CAM', 'B switches player view to car cam');
  check(await spec.locator('#specBallCam').evaluate(e => !e.classList.contains('active')), 'ball-cam button reflects disabled preference');
  await spec.waitForFunction(() => document.querySelector('[data-boost="0"]')?.textContent !== '', null, { timeout: 10000 });
  check(true, 'boost labels repopulate after view controls rebuild');
  await spec.keyboard.press('KeyB');
  check(await spec.locator('#specBallCam').evaluate(e => e.classList.contains('active')), 'ball-cam button reflects enabled preference');
  // Force a long goal pause to exercise camera changes while the ball is absent.
  await host.evaluate(() => { window.__game.phase = 'goal'; window.__game.goalPause = 60; });
  await spec.waitForFunction(() => window.__spectator.game.phase === 'goal', null, { timeout: 10000 });
  await spec.keyboard.press('KeyO'); await spec.keyboard.press('Digit1');
  await spec.waitForFunction(() => document.getElementById('camMode').textContent === 'CAR CAM', null, { timeout: 10000 });
  check(true, 'switching player view during a goal pause keeps car cam');
  await spec.keyboard.press('KeyB'); // choose car cam during the pause
  await host.evaluate(() => { window.__game.phase = 'play'; window.__game.goalPause = 0; });
  await spec.waitForFunction(() => window.__spectator.game.phase === 'play', null, { timeout: 10000 });
  check((await view()).ballCam === false, 'goal pause preserves the latest viewer preference');
  await shot(spec, '05-player-carcam.png');
  await spec.keyboard.press('KeyF');
  const before = await camPos();
  await spec.keyboard.down('KeyW'); await spec.keyboard.down('Space');
  await spec.waitForFunction((b) => Math.hypot(...window.__renderer.camera.position.toArray().map((v, i) => v - b[i])) > 5, before, { timeout: 15000 }).catch(() => {});
  await spec.keyboard.up('KeyW'); await spec.keyboard.up('Space');
  const after = await camPos();
  console.log('free', JSON.stringify(await view()), JSON.stringify(before), JSON.stringify(after), await spec.locator('#fps').innerText(), await host.locator('#fps').innerText().catch(() => '?'));
  check((await view()).mode === 'free' && Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]) > 5, 'free camera flies with W and Space');
  check(await spec.evaluate(() => {
    const before = window.__renderer.camera.fov;
    window.dispatchEvent(new Event('resize'));
    return Math.abs(window.__renderer.camera.fov - before) < 1e-6;
  }), 'resize leaves the free camera projection under free-camera control');
  await shot(spec, '06-free-cam.png');
  await spec.getByRole('button', { name: /Overview/ }).click();
  check((await view()).mode === 'overview', 'Overview button returns to the overview');
  await spec.getByRole('button', { name: /Host QA/ }).click();
  check((await view()).mode === 'player', 'player button follows that player');
  await spec.keyboard.press('KeyH');
  check(await spec.locator('#specBar').isHidden(), 'H hides the overlay for a clean feed');
  await spec.keyboard.press('KeyH');

  const phoneCtx = await browser.newContext({
    viewport: { width: 390, height: 780 }, hasTouch: true,
    storageState: await specCtx.storageState(),
  });
  await phoneCtx.addInitScript(lowQuality);
  await phoneCtx.addInitScript(pauseRender);
  const specPhone = await phoneCtx.newPage();
  await specPhone.goto(`${SPEC}/?spectate&room=${code}`, { waitUntil: 'domcontentloaded' });
  await specPhone.waitForFunction(() => window.__spectator?.ready, null, { timeout: 40000 });
  await host.waitForFunction(() => window.__session.lobby.spectators === 2, null, { timeout: 10000 });
  check(true, 'second spectator (same login, phone viewport) joins mid-match');
  await specPhone.waitForTimeout(800);
  await shot(specPhone, '07-phone.png');
  const phoneView = await specPhone.evaluate(() => window.__view);
  await specPhone.locator('#specHide').tap();
  check(await specPhone.locator('#specBar').isHidden(), 'touch Hide removes the spectator bar');
  const reveal = specPhone.getByRole('button', { name: 'Show controls', exact: true });
  check(await reveal.isVisible(), 'hidden overlay leaves a visible touch control to restore it');
  await reveal.tap();
  check(await specPhone.locator('#specBar').isVisible(), 'touch Show controls restores the spectator bar without a keyboard');
  check(JSON.stringify(await specPhone.evaluate(() => window.__view)) === JSON.stringify(phoneView), 'restoring controls preserves the current camera view');
  await specPhone.locator('#specHide').tap();

  await spec.keyboard.press('Slash');
  await spec.keyboard.press('KeyH');
  await host.keyboard.up('KeyW'); await host.keyboard.up('KeyD');
  await host.evaluate(() => window.__menu.onEndMatch());
  await spec.waitForFunction(() => !window.__spectator.ready && !document.getElementById('specWait').hidden, null, { timeout: 10000 });
  check(true, 'spectator returns to waiting when the host ends the match');
  await specPhone.waitForFunction(() => !window.__spectator.ready && !document.getElementById('specWait').hidden, null, { timeout: 10000 });
  check(await reveal.isHidden(), 'touch reveal control disappears when the host ends the match');
  check(await spec.evaluate(() => !document.body.classList.contains('ui-hidden') && document.getElementById('specHelp').hidden), 'match end resets hidden overlay and help');
  await host.evaluate(() => window.__menu.onStartMatch());
  await spec.waitForFunction(() => window.__spectator?.ready && window.__spectator.game.phase === 'countdown' && document.getElementById('banner').style.display === 'block', null, { timeout: 15000 });
  check(true, 'rematch displays a fresh countdown banner');
  await host.evaluate(() => window.__session.leave());
  await spec.waitForFunction(() => !window.__spectator && !document.getElementById('specJoin').hidden, null, { timeout: 15000 });
  check((await spec.locator('#specStatus').innerText()).length > 0, 'host departure returns the spectator to the code screen with a reason');
  await specPhone.waitForFunction(() => !window.__spectator && !document.getElementById('specJoin').hidden, null, { timeout: 15000 });
  check(await reveal.isHidden(), 'touch reveal control stays hidden after host departure');
  await phoneCtx.close();
  check(!(report.pageErrors?.length), 'browser run has no uncaught page errors');
  report.passed = report.checks.length;
} catch (err) {
  for (const p of browser?.contexts().flatMap(c => c.pages()) ?? []) {
    report.failureState = [...(report.failureState ?? []), await p.evaluate(() => ({ url: location.href, gate: document.querySelector('.access-status')?.textContent, spec: document.getElementById('specStatus')?.textContent, hasSpectator: !!window.__spectator, res: performance.getEntriesByType('resource').map(e => e.name).filter(n => !n.includes('/assets/')).slice(-12) })).catch(e => String(e))];
  }
  console.log('FAILURE STATE', JSON.stringify(report.failureState));
  await browser?.contexts()[1]?.pages()[0]?.screenshot({ path: `${evidence}/failure.png` }).catch(() => {});
  throw err;
} finally {
  await writeFile(`${evidence}/spectator-browser-report.json`, JSON.stringify(report, null, 2));
  await browser?.close();
  server.kill('SIGTERM');
}
