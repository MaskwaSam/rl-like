# RL-like

A browser car-soccer game in the spirit of Rocket League: free play, or online matches with friends hosted straight from one player's browser tab. Gamepad or keyboard, rebindable controls.

Play it at https://jatinmunjal2k.github.io/rl-like/ (deployed from `main` by GitHub Actions).

## Run locally

```bash
npm install
npm run dev
```

Open the printed URL (default http://127.0.0.1:5173). Press any button on a connected controller so the browser exposes it. The game starts on a menu with **Free Play**, **Multiplayer** and **Settings**. Esc or Start opens the menu during play; free play pauses, an online match keeps running.

## Arenas

Choose **Arenas** from the main or pause menu to preview **Daylight Stadium**, **Neon Night**, **Industrial Indoor**, or **Maskwa Arena**. Your free-play choice is saved in this browser and becomes the default when you create a room. In a multiplayer lobby, the room owner uses **Choose arena**; everyone receives the same venue. End the match before choosing a new arena for the next match. Field dimensions, collision geometry, pads, car handling and controller bindings are identical in all four venues.

Arena IDs and labels live in `src/arenas.ts`. The shared pitch, sky and lighting are in `src/render/renderer.ts`; the stadium seating is in `src/render/stadium.ts` and the indoor shell in `src/render/industrial.ts`. The first three venues use original procedural 3D geometry and textures. Maskwa Arena adds the school’s cyan/navy palette, name banners, the supplied MCHS badge and the actual Maskwa Bear sports-team emblem supplied by Sam. Asset provenance is recorded in `src/assets/README.md`. Keep appearance changes in these render files so physics and multiplayer remain independent.

## Peer-hosted multiplayer

One player picks **Multiplayer → Host a room** and gets a five-letter code. Friends open the same site, enter the code and **Join**. The lobby shows eight places, four per team, the match length, and **Start match**. New players join the smaller team; switching into a full team is blocked by the host. Up to **4v4**, with smaller matches supported. People can join or leave mid-match. Rejoining with the room code uses a vacant slot and the new player's selected body and controls; it does not restore a disconnected player's identity automatically.

For a repeatable local check, run `node qa/run-headless.mjs` (21 simulation/session checks with in-memory transport). With the development server running, open `/qa/multiplayer.html` and click **Run eight-player verification** for one real PeerJS/WebRTC host and seven client sessions. That page exercises capacity, team limits, snapshots, sustained input, cosmetic bodies, disconnect/rejoin, reset/end and a smaller match. It is not included in `dist/`, and a run closes all its test connections. Eight sessions on one browser do not establish eight-person cross-network performance.

**1v1, 2v2, 3v3 and 4v4** use the players currently in the room, with one to four on each team. There is no separate mode selector or fixed-size admission setting. The host can also start solo or with unequal teams, and people can join during play. `node qa/run-headless.mjs modes` checks all four balanced sizes (lobby, kickoff/countdown, snapshots/bodies, clocks, sustained input/boost, reset, goals, end and immediate rematch) and verifies the current solo/unequal-team start rules: 51 additional headless checks, including lobby/match arena synchronization and switching for rematches.

How it works:

- **The host's tab is the server.** It runs the authoritative `Game` at 120 Hz, applies every player's input for the tick it was stamped with (repeating the last one when a packet is late) and sends the complete game state to each client 60 times a second (about 1.1 KB with eight cars, plus the packet header).
- **Transport is WebRTC via PeerJS.** PeerJS's free public broker only does the introduction; game traffic flows peer to peer. On top of PeerJS's reliable channel a second data channel is opened unordered with no retransmits, so a lost packet never delays the ones behind it; if that channel cannot be set up, packets fall back to the reliable one.
- **A relay (TURN) is required for most pairs of players.** Two peers connect directly only when one side's router accepts an inbound connection. Between two home networks, on mobile or carrier-grade NAT, or even between two browser profiles behind a router that will not hairpin, the only path is a TURN relay. PeerJS's built-in relay hosts (`eu-0`/`us-0.turn.peerjs.com`) no longer resolve in DNS, so the defaults are not used: `src/net/transport.ts` ships its own STUN list and reads relay credentials at runtime from `public/turn.json`, which is deployed with the site. Leave it empty and the game still runs, but only directly-reachable pairs can connect. **Multiplayer → Test connection** reports exactly what the current network allows.

A relay is configured (Metered, free tier). Append `?relay=1` to the URL to force every connection through it, which reproduces the two-different-networks case from a single machine: verified at a `relay -> relay` candidate pair, 61 ms round trip, 60 snapshots a second and no mispredictions.

To change the relay, edit `public/turn.json` and redeploy (a push to `main` is enough). Either form works:

```json
{ "credentialsUrl": "https://<your-app>.metered.live/api/v1/turn/credentials?apiKey=<key>" }
{ "iceServers": [{ "urls": "turn:host:3478", "username": "u", "credential": "c" }] }
```

The second is what the Metered dashboard's **TURN Server -> Show ICE Servers Array** gives you, and is what ships here. Those credentials are scoped to relaying only: they spend the account's bandwidth quota and can do nothing else, which is why they belong in client code. Metered's account-wide **secret key** must never go near the front end. Game traffic is about 40 KB/s per player pair, so the free quota covers well over a hundred hours; regenerate the credential in the dashboard if it is ever abused, and leave auto-recharge off so the balance is a hard ceiling.
- **Clients predict.** Each client runs its own `Game` a few ticks ahead of the host, so its car and the ball react instantly. Every snapshot is compared with what the client predicted for that tick; when they differ (someone else touched the ball, an input arrived late) the client rewinds to the snapshot and replays its unacknowledged inputs. Because Rapier is deterministic and the whole state is serialised, a replay of untouched play is bit-identical, so most snapshots need no replay at all. Corrections are folded into a visual offset that fades over about a tenth of a second instead of snapping.
- **Other cars are shown from snapshots**, interpolated a few ticks in the past (extrapolated briefly if a packet is lost), with the player's name floating above.
- **Clock sync.** Each snapshot tells the client how far ahead of the host's simulation its inputs are arriving; the client speeds up or slows its simulation slightly to keep about three ticks of margin, jumps only after the lead has been badly off for half a second, and catches up locally when a late frame let the host get ahead.
- **Background tabs.** Browsers throttle a hidden tab's frame loop to about once a second, which would freeze a hosted match. A tiny Web Worker (whose timers are not throttled) ticks the network session while the tab is hidden, so the host can tab out without stopping the game. The player's own car coasts meanwhile.
- **Match flow online:** three-second kickoff countdown with cars frozen, RocketSim's kickoff placement (blue takes shuffled spawn *i*, orange the mirror), real boost with pads, a match clock (unlimited, 3, 5 or 10 minutes), overtime with a fresh kickoff on a tie, and a result banner. Dodge deadzone is a player setting, so each client sends theirs and the host simulates that player's car with it.

Known limits: a client cannot reset the match; if the host closes the tab the room ends; the PeerJS public broker occasionally refuses connections, in which case hosting again gets a new code. The host sends seven snapshot streams in a full 4v4 match, so connection quality and host performance matter.

## Deploying

`.github/workflows/deploy.yml` builds `dist/` with Vite and publishes it to GitHub Pages on every push to `main` (Pages source set to *GitHub Actions*). Vite's `base: './'` keeps the site working under the `/rl-like/` path. Nothing else to run: the multiplayer needs no server of ours.

## Default controls

| Action | Gamepad (standard mapping) | Keyboard |
| --- | --- | --- |
| Throttle / reverse | RT / LT | W / S |
| Steer, air yaw | Left stick | A / D |
| Air pitch | Left stick | W / S |
| Jump, double jump, dodge | A | Space |
| Boost | B | Left Shift |
| Powerslide | X | Right Shift |
| Air roll (free): stick X axis rolls | X | Right Shift |
| Air roll left / right | LB / RB | Q / E |
| Toggle ball cam | Y | C |
| Reset match | Back | Unassigned |
| Menu | Start | Esc |

Everything except the steering axis can be rebound in Settings. Bindings persist in the browser.

Landed on your roof? Press jump (RL's autoflip). On your side, hold throttle (autoroll). Flip cancel works: pitch against a flip while it is running.

## Build identity

Every build is stamped with the commit it came from. The menu (which is also the pause screen) shows it in the bottom right, for example `v0.1.0 · 4e9c735 · 2026-09-19 06:33`, and the same string is logged to the console at startup. A build made from a working tree with uncommitted edits says `uncommitted`, so a local test is never mistaken for a deployed one.

Quote that string when reporting anything: it maps straight back to `git show <sha>`. It comes from `vite.config.ts`, which runs git at build time and injects the values, so it needs no upkeep.

## Architecture

```
src/
  sim/        Deterministic fixed-tick simulation (120 Hz). No DOM, no rendering.
    rl.ts          VERIFIED Rocket League values, in unreal units, with sources
    tuning.ts      Every approximation or invented value, with what RL does instead
    arena.ts       Analytic arena mesh: ramps, corners, goal mouths, goal boxes, backstops
    car.ts         Octane on a Rapier body driven like RocketSim drives Bullet (see below)
    game.ts        World, ball, car-ball extra impulse, goal detection, snapshots
  input/      Gamepad + keyboard -> CarInput, rebindable actions
  render/     three.js scene (kept cheap), chase camera. Consumes snapshots only.
  ui/         Menu and controls settings
  main.ts     Frame loop: fixed-step accumulator, interpolated rendering, pause on menu
```

The simulation only depends on Rapier and three's math classes, so it can run headless in Node. That is the seam the multiplayer uses: the host runs `Game.step` with every player's `CarInput`, clients predict locally and reconcile from serialised game states (`Game.serialize` / `Game.restore`).

```
src/
  net/
    protocol.ts    Control messages (JSON) and binary packets: inputs, snapshots, ping
    transport.ts   PeerJS signalling, one reliable + one unreliable data channel per peer
    session.ts     Session interface shared by free play, host and client
    host.ts        Lobby, input buffering per client, authoritative stepping, snapshot broadcast
    client.ts      Prediction, reconciliation, remote-car interpolation, visual smoothing
  sim/state.ts     Byte writer/reader, input quantisation, seeded RNG
```

## Car model

The car follows RocketSim's reverse-engineered vehicle:

- Rigid body origin at RL's car origin (axle height) with the Octane hitbox offset 13.9 uu forward and 20.8 uu up, mass 180, box inertia.
- Four wheel rays from the real hardpoints. Each contacting wheel applies a Bullet raycast-vehicle spring/damper impulse (stiffness 500, damping 25/40, force scales 35.75 front / 54.27 rear, 12 uu travel, never pulling).
- Wheel friction as impulses: Bullet's bilateral side constraint (0.2 damping through the inertia Jacobian) times RL's lateral friction curve; engine force 400 uu/s² per wheel with the speed-torque curve; brake 875 uu/s² per wheel with RocketSim's rolling-friction constant; handbrake blends the steer-angle curve and scales friction; no-throttle "non-sticky" factor; impulses applied at chassis height like RocketSim.
- Front wheels steer by RL's steer-angle-from-speed curve. Turn rates come out at 2.16 rad/s at 14 m/s and 1.79 at 23 m/s against RL's measured 2.2 and 2.02.
- Sticky force: 0.5 g into the surface, plus (1 - |up|) g when throttling or moving, so walls hold and the ceiling does not.
- Jump, double jump, dodge impulses with speed scaling, flip torque with flip cancel, vertical damping window, pitch lock, air control torque and damping, autoflip, autoroll, boost ground/air and minimum time, supersonic tracking, ball speed and spin caps, car-ball extra impulse.

## Constants: real vs approximate

`src/sim/rl.ts` holds only values taken from RocketSim's source or the RLBot wiki, each tagged with its source. `src/sim/tuning.ts` holds everything else and explains what the real game does instead. Remaining approximations:

- Wheel bilateral Jacobian computed analytically for a static ground (Bullet's does the same for our case, but this is our derivation).
- RocketSim's "extra pushback" when a wheel ray sinks into geometry is omitted; Rapier's hitbox collision covers it.
- Autoroll torque is a proportional alignment instead of RL's torque through the inertia tensor.
- Car-ball restitution ends at 0.18 (RL 0.0); friction is exact (2.0).
- Arena shape is fitted to measurements of RL's real collision mesh (parsed from RocketSim `.cmf` files, not redistributed): side-wall and corner floor ramps r = 256 uu, back-wall floor ramps r = 160, wall-to-ceiling arcs r = 550, corner walls on |x|+|y| = 8064 blended into the back wall (r ≈ 800) and side wall (r ≈ 680).
- The goal is a tube, not a box: netting at x = ±896, a quarter-pipe back (r = 256, centred 624 uu behind the mouth) that curls forward past vertical to 477 high, a roof sloping up to 640 at 224 uu behind the crossbar, then the flat lintel to the mouth. Drive in fast and you ride up the back, along the roof upside down, and out through the mouth, as in RL. Still square: the ~96 uu fillets where the roof meets the netting and where posts meet the back-wall ramp.

## Visuals and sound

Reference footage: a pro's free-play session (Zen, https://www.youtube.com/watch?v=2goJD60z9Zs), sampled frame by frame for the pad pickups, ball streak, boost trails, glass walls and camera framing.

- The car is a boxy hot hatch in the Fennec mould, built in code rather than loaded: one extruded and bevelled side profile (short overhangs, raked screen, long flat roof, blunt tail) sized directly from the Octane hitbox, with a glasshouse, skirt, bumpers, lights and a roof spoiler on top. Wheels sit at RL's hardpoints and radii, steer with RL's steer curve, spin with speed and ride the suspension from the physics ray probe. Nothing is downloaded, so there is no load delay and the visible car is exactly the shape the physics collides with.
- Boost pads are RL-style pickups: the six big pads float a glowing orb about a metre up on a lit ring, the small pads are a lit ring; a pad on cooldown loses its orb and its ring goes dark, and a pickup pops a short glow. Nine draw calls for all 34.
- A ground marker: a ring on the floor directly beneath the ball at all times, fading in as the ball leaves the ground and growing slightly with height, so its horizontal position stays readable when it is high.
- Controllers rumble on landings, ball hits, wall hits, dodges, boost, bumps, demolitions and goals (dual-rumble where the browser supports it).
- HUD: ping sits next to the frame rate in the top right during an online match.
- The ball has a hexagon-panel texture, a soft additive glow, a blob shadow on the floor that fades with height, and a white streak (camera-facing ribbon) once it moves faster than about 14 m/s. Cars have a blob shadow and a short team-coloured boost trail behind the flame.
- Goals burst: a flash, an expanding ring and a spray of points in the scoring team's colour at the ball's last position.
- The daylight stadium has three stepped seating tiers, instanced spectators, roof trusses, hanging team flags, floodlights and live scoreboards. Transparent hexagon safety mesh follows the original collision arena above an opaque lower ramp; wall and ceiling driving still use the same physics. An original sky/cloud dome, environment reflections and blue/orange goal-zone turf complete the presentation. All new arena artwork is generated in code; no reference assets are downloaded.
- The floor is one static 2048 px texture: turf stripes, boundary, goal lines, centre circle, goal boxes and arcs, boost pad rings. Drawn once at startup, zero per-frame cost.
- The car is a Fennec-style body of a dozen boxes on the Octane hitbox, with four wheels at RL's hardpoints that spin with forward speed and steer with RL's steer-angle curve.
- Sound mixes samples and synthesis. Sampled (all CC0, see `public/CREDITS.md`): two engine loops crossfaded and pitched by speed, a boost roar with an ignition burst, three ball impacts and three car impacts picked at random with pitch variation and distance attenuation, soft and hard landings, big and small pad pickups, countdown tick and go, goal crunch and boom. Synthesised: jump, double-jump and dodge whooshes, tyre roll and skid, supersonic wind, the goal horn. Everything runs through a compressor so stacked impacts never clip, and every sample has a synthesised stand-in if it fails to load. Nothing is taken from Rocket League itself, and there is no ambience of any kind: every layer is driven by the player, so a stationary car with no input is silent. Volume is in Settings → Gameplay.

## Settings

Settings → Controls (bindings), Camera (FOV, distance, height, angle, stiffness with RL's ranges; defaults are the common pro setup 110 / 270 / 100 / -3 / 0.45) and Gameplay (steering sensitivity, aerial sensitivity, controller deadzone, dodge deadzone, sound volume). Every slider has a description. The menu works with mouse, keyboard (arrows, Enter, Backspace) and gamepad (D-pad or stick, A, B). Everything persists in the browser.

The camera is a measured copy of car-soccer.com's camera kernel, which implements Rocket League's rules. That kernel is compiled WebAssembly, so it was probed as a black box: the same car and ball placements were fed to it and to `FollowCamera`, and every probe (dozens, covering kickoff, high balls at several heights and distances, each camera setting varied in isolation, speed, supersonic, walls, slopes, the ceiling and the car pitched or rolled in the air) matches to within 0.1° of pitch and a few uu of position. The rules it encodes:

- A pivot sits `height` above the car. The camera is pulled `distance` back along the smoothed view direction, so the −3° `angle` also raises it by 14 uu. The arm grows with speed by (1 − stiffness) × speed / 20 uu, which is all stiffness does. The camera never drops below 10 uu. FOV is horizontal and widens by 10° while supersonic.
- Ball cam: yaw points at the ball; the pivot rises 0.9 uu per degree of the ball's elevation; pitch blends from `angle` toward the ball's elevation with a weight that ramps from 0 at 22° to 0.8 at 44° and never exceeds 0.8. A ball straight overhead is followed only 80% of the way, so the car leaves the frame, as in RL. First-order lag of 8.6/s.
- Car cam: yaw follows the nose heading, held through flips (a heading jump past 90° is ignored) and near-vertical noses. In the air the pitch is just `angle` and the roll is level, so air rolls and flips leave the view alone. On a surface the pivot rides the car's up, the pitch follows about 75% of the nose pitch and the roll a tenth of the car's roll. First-order lag of 24.7/s.

Speeds show in km/h (1 uu/s = 0.036 km/h; 2300 uu/s is 83 km/h).

Car-ball contact follows RocketSim's `_OnHit`: restitution 0, the extra impulse computed from pre-collision velocities and positions, applied at most every other tick and only while the ball is still approaching. A 2000 uu/s flat hit on a resting ball leaves at about 3050 uu/s and 16°, peaking around 7 m.

## Bumps and demolitions

Cars collide as rigid bodies through Rapier, and RL's two extras sit on top. Driving one car into another on car-soccer.com's RocketSim build and reading the victim's `DEMOED` flag settled the rule: **a demolition happens when the attacking car's supersonic flag is set, not at any particular impact speed.** Contacts at up to 1508 uu/s relative never demolished while the flag was clear, and one at just 1040 uu/s did once it was set, because the flag lingers for a second after the car drops back below 2200. The victim respawns after 360 ticks, exactly 3.0 s; ours measures 3.008 s. Teammates never demolish each other.

A demolished car is frozen and parked below the floor rather than removed, so its id, collider and network state survive the three seconds intact. The bump impulse for non-demolishing contacts is a straight proportion of relative speed with RL's upward kick (`tuning.ts`): the measurement could not separate it from the rigid-body collision cleanly enough to fit RL's curve.

## Physics audit against RocketSim

car-soccer.com ships RocketSim compiled to WebAssembly. Driving that build headlessly with the same inputs as our `Game` gives a direct comparison (all values uu, uu/s, rad/s at 120 Hz):

| Test | RocketSim | RL-like |
| --- | --- | --- |
| Rest pose (origin z, pitch) | 17.03, −0.55° | 17.02, −0.55° |
| Held jump height / tap jump / double jump | 214.8 / 72.1 / 444.6 | 214.8 / 72.1 / 444.4 |
| Held jump z every 1/12 s | 26.1 57.5 92.4 123.4 149.9 171.8 189.2 202.2 210.6 214.5 | identical to 0.1 |
| Forward dodge speed gain | 500 | 500 |
| 0 → 2200 with boost, 0 → 2290 | 1.583 s, 1.675 s | 1.583 s, 1.675 s |
| Throttle-only top speed | 1410.1 | 1410.2 |
| Throttle acceleration, brake, coast traces | | match within 1% |
| Steady full-throttle turn: speed, yaw rate, radius | 1227, 2.348, 523 | 1228, 2.348, 523 |
| Turn curve from rest (12 samples) | | within 0.5% |
| Powerslide yaw rate build-up (0.125 s steps) | 2.25 2.82 3.07 3.25 3.33 3.56 | 2.31 2.83 3.08 3.25 3.33 3.65 |
| Side flip: z and up.z every 0.1 s, landing tick | landed 137 | landed 138, values within 2 uu / 0.03 |
| Ball bounce apex ratio | 0.44 | 0.44 |
| Boosted kickoff hit: ball speed, elevation, apex | 3014, 18.4°, 797 | 3039, 17.0°, 705 |

Three of these were fixes found by the comparison: a 25th tick of jump acceleration from float64 tick accumulation, the ball's collision radius (91.25, not 92.75), and the suspension rest lengths (RocketSim's car sits 1.9 uu higher and 0.55° nose down than the raw config values give, which was also the whole source of a 10% turn-radius error). Remaining known gaps: the kickoff hit leaves about 1.5° lower (Rapier's box-sphere contact normal vs Bullet's margin-rounded box), and RocketSim applies steering and braking to the wheels one tick later than we do.

## Match flow and HUD

- 34 boost pads at RL's positions with RL's pickup volumes (cylinder 208/144 uu radius, 95 uu tall, or box 160/120 uu, 64 uu tall), 100 / 12 boost, 10 s / 4 s cooldown. Free play currently uses infinite boost; pads still light up and recharge.
- Reset cycles through RL's five spawn points in a shuffled order that changes every cycle (RocketSim's kickoff placement with more cars: blue car *i* takes spawn *i* of the shuffle, orange the mirror image).
- On a goal the ball disappears for 2 s while play continues; then cars and ball reset to kickoff. The banner shows the scorer and the goal speed in km/h.
- Wheel "extra pushback" (RocketSim): past 2.5 uu of compression a wheel ray acts as a rigid contact, so hard or tilted landings stop on the wheels instead of sinking the hitbox into the floor and being fired back up by the springs.
- HUD: score, FPS (top right), ball-cam indicator and controller status (bottom left), speed in uu/s and an RL-style boost gauge (bottom right). Speed turns red, larger and pulsing at the 2300 uu/s cap; the boost flame goes white when supersonic.
- The left-side main menu shows over an elevated stadium view. Submenus use the same arena background; the Garage retains its rotating showroom. Gameplay has a segmented boost gauge, compact team score tiles and free-play shortcuts. Opening the menu still pauses free play while online matches continue.

## Engine note: why flips come round a full turn

RocketSim applies the flip torque before the physics step and clamps angular speed to 5.5 rad/s only after it, so each step's rotation integrates at 5.5 plus one tick of torque (about 7.7 rad/s for side flips, 7.4 for front flips). Over the 0.65 s torque phase that is ~285°, and the damped coast brings a flip to ~350° by landing. We replicate the order exactly: caps live in `Car.postStep`. Clamping before the step gave 270° flips that landed on their side.

## Engine note: gyroscopic precession

Rapier integrates gyroscopic precession for the car's box inertia, so any rotation about a non-principal axis (every diagonal flip) would tumble and drift the heading. Bullet, and therefore Rocket League, does not. After each physics step, if nothing touched the car, its pre-step angular velocity is restored (`Car.postStep`).

## Physics still missing compared to Rocket League

1. The bump impulse curve (the demolition rule itself is measured; see below).
2. Respawn positions for more than five cars per team.
3. Exact arena mesh details above.
4. Supersonic has no gameplay effect beyond the indicator (in RL it matters for demos).
5. RocketSim itself compiled to WebAssembly would replace `sim/` for tick-exact physics.
