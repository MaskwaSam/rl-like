// Run with node qa/car-friction-runner.mjs. Baseline is loaded from git, never a checkout.
import assert from 'node:assert/strict';
import { Game as BaselineGame } from 'car-friction:baseline/game.ts';
import { Game as CandidateGame } from 'car-friction:candidate/game.ts';
import { __carFrictionStats as before } from 'car-friction:baseline/car.ts';
import { __carFrictionStats as after } from 'car-friction:candidate/car.ts';
import { EMPTY_INPUT, type CarInput } from '../src/input/types';
import { TICK_DT } from '../src/sim/rl';
import { Quaternion, Vector3 } from 'three';

const config = { infiniteBoost: true, countdown: 0, matchSeconds: 0, seed: 41 };
let snapshots = 0;
const contactTicks = [0, 0, 0, 0, 0];
let demoTicks = 0;
let landings = 0;
for (const scenario of ['drive-steer-boost-slide-brake', 'airborne-partial-landing-demo']) {
  const baseline = await BaselineGame.create(config);
  const candidate = await CandidateGame.create(config);
  try {
    for (const game of [baseline, candidate]) {
      for (let id = 0; id < 8; id++) {
        game.addCar(id, id % 2 ? 'orange' : 'blue');
        const car = game.cars.get(id)!;
        car.reset((id - 3.5) * 6, id % 2 ? -12 : 12, id % 2 ? Math.PI : 0);
        if (scenario.startsWith('airborne')) {
          car.body.setTranslation({ x: (id - 3.5) * 6, y: id < 4 ? 3 + id : .45, z: 0 }, true);
          car.body.setRotation(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), (id - 3.5) * .11), true);
          car.body.setLinvel({ x: id % 2 ? 2 : -2, y: -1, z: -3 }, true);
        }
      }
    }
    const previous = new Array(8).fill(0);
    for (let tick = 0; tick < 720; tick++) {
      const inputs = new Map<number, CarInput>();
      for (let id = 0; id < 8; id++) inputs.set(id, {
        ...EMPTY_INPUT,
        throttle: tick < 500 ? 1 : tick < 620 ? -1 : 0,
        steer: tick < 100 ? 0 : (id % 2 ? .65 : -.45),
        boost: tick >= 140 && tick < 240,
        handbrake: tick >= 300 && tick < 440,
        jump: tick === 245 || tick === 265,
        pitch: tick > 245 && tick < 280 ? .4 : 0,
        roll: tick > 245 && tick < 280 ? -.3 : 0,
      });
      if (scenario.startsWith('airborne') && tick === 400) {
        for (const game of [baseline, candidate]) {
          const car = game.cars.get(3)!;
          car.setDemoed(true);
          car.demoTimer = 30 * TICK_DT;
        }
      }
      before.impulses.length = after.impulses.length = 0;
      baseline.step(inputs, TICK_DT);
      candidate.step(inputs, TICK_DT);
      assert.deepEqual(new Uint8Array(candidate.snapshotBytes()), new Uint8Array(baseline.snapshotBytes()), `${scenario} snapshot tick ${tick}`);
      assert.deepEqual(after.impulses, before.impulses, `${scenario} ordered friction impulses tick ${tick}`);
      for (const car of candidate.cars.values()) {
        contactTicks[car.numWheelsInContact]++;
        if (car.demoed) demoTicks++;
        if (!previous[car.id] && car.numWheelsInContact) landings++;
        previous[car.id] = car.numWheelsInContact;
        assert.deepEqual(car.debug, baseline.cars.get(car.id)!.debug);
      }
      snapshots++;
    }
  } finally { baseline.destroy(); candidate.destroy(); }
}
assert(contactTicks[0] > 0 && contactTicks[1] > 0 && contactTicks[2] > 0 && contactTicks[3] > 0 && contactTicks[4] > 0, 'exercise every contact count');
assert(demoTicks > 0 && landings > 8, 'demo and landing coverage');
assert.equal(after.calls, before.calls);
assert.equal(after.contacts, before.contacts);
assert.equal(before.arrays, before.calls * 2);
assert.equal(before.vectors, before.contacts * 2);
const expectBaseline = process.env.CAR_FRICTION_EXPECT_BASELINE === '1';
assert.equal(after.arrays, expectBaseline ? before.arrays : 0);
assert.equal(after.vectors, expectBaseline ? before.vectors : 0);
console.log(JSON.stringify({ snapshots, cars: 8, contactTicks, demoTicks, landings, baseline: before, candidate: after }, (key, value) => key === 'impulses' ? undefined : value, 2));
console.log('PASS byte-identical snapshots, ordered friction impulses and diagnostics; measured allocation sites');
