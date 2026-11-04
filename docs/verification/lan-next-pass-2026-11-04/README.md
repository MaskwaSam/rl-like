# Next LAN performance opportunities — November 4, 2026

Read-only review of source `8edc0ab27dcba26b33ca761c7cb624469fff0aea`, including a
scoped independent Sol review. These are proposed follow-up changes, not changes
included in the dedicated-server release. No new gameplay code was edited.

## Recommended implementation order

1. **Avoid rebuilding the pending-input list every rendered frame.**
   `src/net/client.ts:306` calls `sendInputs()` even when a frame has no physics
   steps. At `:327`, it copies Map keys, filters and sorts them, then builds a new
   input list before encoding at most 32 inputs. Maintain an ordered pending
   window or reusable scratch storage while preserving the exact newest
   consecutive run, packet bytes, cadence and retransmission behavior. Simply
   skipping zero-step frames would change loss recovery. This is the smallest
   first change and benefits LAN players as well as eligible server-client sends.
   Compare packet bytes and timestamps at 30/60/120/144/240 Hz, including ACK
   jumps, missing ticks, loss, catch-up, resync and the 32-input boundary.

2. **Reuse prediction-history storage.**
   `src/net/client.ts:340` allocates a 17-element Float32Array and metadata for
   every predicted or replayed tick. `src/sim/game.ts:679` also copies score,
   spawn-order and pad-cooldown containers. A bounded pool can reduce garbage
   collection pressure. Every retained tick must own independent storage; do not
   shorten the existing history window. Verify exact physics and metadata through
   correction/replay, countdowns, pad expiry, collisions, long delays and rematches,
   including explicit checks for accidentally aliased history records.

3. **Check LAN transport readiness before encoding.**
   `src/net/host.ts:379` captures state and encodes recipient packets before
   `src/net/transport.ts:446` can discard them for backpressure. Add a non-consuming
   readiness check that skips encoding for blocked recipients and skips shared
   state capture only when every due recipient is blocked. Keep the final send
   check, watchdog and heartbeat-pair behavior. Test mixed healthy/blocked peers,
   reliable fallback, queue drain, stall recovery and closure races. This saves
   work during congestion; healthy links may see little benefit. PeerJS already
   forwards the raw buffer on this path, so another serializer bypass is unnecessary.

## Measure the actual LAN path

Physical-device frame timing and network measurements are still needed to identify
the dominant bottleneck. Record frame-time percentiles, long frames/GC, input RTT,
snapshot age and packet drops while playing on two separate devices. Verify the
active connection uses a direct path rather than a relay before attributing a
latency problem to simulation work. Do not remove relay fallback or lower gameplay
rates just to improve a benchmark.

The current `selectedPair` diagnostic (`src/net/transport.ts:145`) iterates all
successful ICE candidate pairs once when connected; it does not explicitly select
the active transport's pair and can become stale. A measurement pass should use
the actual selected pair and refresh it when the route changes. This is a
diagnostic accuracy improvement, not an established gameplay failure.

These source findings do not establish FPS or latency gains. No new browser,
physical LAN, mobile, controller or visual comparisons were conducted for this
review. Proposed changes should preserve visuals and simulation behavior, then
receive packet/state regression checks and two-device runtime measurements.
