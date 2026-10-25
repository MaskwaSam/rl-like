import assert from 'node:assert/strict';
import { MatchRetry, retryInputPressed, type RetryState } from '../src/ui/match-retry';

let checks = 0;
const check = (run: () => void, name: string) => { run(); checks++; console.log(`PASS ${name}`); };
const retry = new MatchRetry();
let state: RetryState = { session: {}, game: {}, host: true, finished: true, menuOpen: false };
let resets = 0;
const reset = () => { resets++; };
check(() => assert.equal(retry.view(state, 0).visible, true), 'finished host sees Retry');
for (const [name, delta] of [
  ['guest', { host: false }], ['active match', { finished: false }],
  ['open menu', { menuOpen: true }], ['departed session', { session: null }], ['loading match', { game: null }],
] as const) {
  check(() => {
    const unavailable = { ...state, ...delta };
    assert.equal(retry.view(unavailable, 0).visible, false);
    assert.equal(retry.activate(unavailable, 0, reset), false);
    assert.equal(resets, 0);
  }, `${name} cannot activate Retry, including programmatic calls`);
}
check(() => {
  assert.equal(retry.activate(state, 0, reset), true);
  assert.equal(resets, 1);
  assert.equal(retry.view(state, 1).pending, true);
  assert.equal(retry.activate(state, 1, reset), false);
  assert.equal(resets, 1);
}, 'pending server reset suppresses repeated click/controller activation');
check(() => {
  assert.equal(retry.view({ ...state, menuOpen: true }, 2).visible, false);
  assert.equal(retry.activate(state, 3, reset), false);
}, 'opening and closing menu does not duplicate pending reset');
check(() => {
  assert.equal(retry.view(state, 4999).pending, true);
  assert.equal(retry.view(state, 5000).pending, false);
  assert.equal(retry.activate(state, 5000, reset), true);
}, 'lost asynchronous reset becomes retryable after bounded timeout');
check(() => {
  assert.equal(retry.view({ ...state, finished: false }, 5001).pending, false);
  assert.equal(retry.view({ ...state, finished: false }, 5001).visible, false);
  assert.equal(retry.activate(state, 5002, reset), true);
}, 'new countdown hides Retry and clears previous pending state');
check(() => {
  state = { ...state, game: {} };
  assert.equal(retry.view(state, 5003).pending, false);
  assert.equal(retry.activate(state, 5003, reset), true);
  state = { ...state, session: {} };
  assert.equal(retry.view(state, 5004).pending, false);
}, 'new game or room identity cannot inherit pending state');
check(() => {
  retry.activate(state, 5005, reset);
  const guest = { ...state, host: false };
  assert.equal(retry.view(guest, 5006).pending, false);
  assert.equal(retry.activate(guest, 5006, reset), false);
}, 'losing host authority revokes pending action');
check(() => {
  assert.throws(() => retry.activate(state, 5007, () => { throw new Error('reset failed'); }), /reset failed/);
  assert.equal(retry.view(state, 5008).pending, false);
  assert.equal(retry.activate(state, 5008, reset), true);
}, 'synchronous reset failure leaves action usable');
// Reproduce main.ts ordering: capture menu state, toggle/navigate (which can close it),
// then evaluate Retry against the now-closed menu using that same input poll.
for (const scenario of [
  { name: 'Resume Match', open: true, toggle: false, accept: true, reset: false },
  { name: 'Return to match', open: true, toggle: false, accept: true, reset: true },
  { name: 'Escape closing with accept/reset', open: true, toggle: true, accept: true, reset: true },
  { name: 'menu toggle then accept', open: false, toggle: true, accept: true, reset: true },
]) {
  check(() => {
    const action = new MatchRetry();
    let menuOpen = scenario.open;
    const menuWasOpen = menuOpen;
    if (scenario.toggle) menuOpen = !menuOpen;
    if (menuOpen && scenario.accept) menuOpen = false; // menu.navigate accepts Resume/Return.
    assert.equal(menuOpen, false, 'fixture must expose the finished-match HUD after menu routing');
    let resets = 0;
    const visibleState = { session: {}, game: {}, host: true, finished: true, menuOpen };
    if (action.view(visibleState, 0).visible && retryInputPressed(menuWasOpen, scenario.toggle, scenario.accept, scenario.reset)) {
      action.activate(visibleState, 0, () => { resets++; });
    }
    assert.equal(resets, 0, 'menu-consumed input must not restart finished match');
    assert.equal(retryInputPressed(false, false, false, false), false, 'holding accept supplies no new edge');
    if (retryInputPressed(false, false, true, false)) action.activate(visibleState, 1, () => { resets++; });
    assert.equal(resets, 1, 'a fresh accept after returning to the HUD must still activate Retry');
  }, `${scenario.name} consumes its input before Retry routing`);
}
console.log(`PASS ${checks} Retry state checks; DOM layout and actual controller edges require browser verification.`);
