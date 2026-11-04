# Bounded spectator release tooling

These tools adapt the October 24 controller-notices helpers. They do not connect,
copy to a server, request secrets, change DNS/provider settings, or install remote
npm dependencies. The operator is a Linux-host program; do not execute its actions
on a workstation. The parent owns approval, transport, authentication setup,
independent review, activation, and public/device acceptance.

## Freeze and package locally

Commit the reviewed integration and these **four** files first. Freeze the exact
new 40-character HEAD; do not use `d90bdd6` after committing the tools. From the
repository, with existing local npm dependencies:

```sh
python3 ops/spectator-release/package.py --expected-source-commit FULL_40_CHARACTER_SHA
# Optional existing absolute staging parent (inside the repo it must be ignored):
python3 ops/spectator-release/package.py --expected-source-commit FULL_40_CHARACTER_SHA --output-parent /absolute/local/staging-parent
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s ops/spectator-release -p test_release.py -v
```

The default staging parent is Python's system temporary directory. Reserve that
location locally, protect the resulting source archive (it includes the tracked
relay configuration), and retain the packet and receipt outside temporary storage
before relying on them for recovery. Existing packet/archive/receipt names are
never intentionally reused. A failed build/package can leave partial artifacts;
inspect them and use a fresh staging parent rather than overwriting evidence.

The clean committed source, worktree bytes and executable modes, exact git archive
commit/inventory, exact output inventories, copied build bytes and final tarball
inventory are checked. `dist/` and `.server-build/` alone are cleared and freshly
built locally. Build commands are the existing `npm run build` and
`npm run server:build`; the operator does no npm install/build. The source allowlist
is an explicit list of the baseline-to-`d90bdd6` paths plus these four owned files.
Any extra/missing changed path fails packaging. The dependency lock and dependency
declarations must match `c825a5e2fe928f6101dc8a949db8ea6c7a64d3bb`.
`public/turn.json` remains opaque: bind it through the supplied size/SHA-256 and
unchanged git blob identity; never print or parse relay credentials. Normal builds
copy that existing public asset unchanged.

Outputs are `20261104-spectator-<12sha>/`, the matching `.tar.gz`, and
`20261104-spectator-<12sha>-receipt.json`. The receipt freezes the archive and
manifest digests. The manifest also pins the operator's digest. Freeze the digest
of `ops/spectator-release/operator.py` independently in the parent's local release
record; run an external copy with that exact digest, never an unverified operator
obtained from a mutable remote packet. Transport/extraction must independently
verify the archive digest and reject links, traversal, duplicates and extra files.
The operator verifies every extracted file against the externally pinned manifest.

## Parent-operated host steps (examples only)

After the parent completes access/login setup and independent review, the packet
belongs at `/home/sam/services/car-soccer/releases/RELEASE`. Run the external pinned
operator as the existing service owner. Each action requires the independently
frozen digest of the operator file, in addition to the manifest digest:

```sh
python3 /absolute/external/operator.py prepare RELEASE MANIFEST_SHA256 --expected-operator-sha256 OPERATOR_SHA256
# Existing candidate images are refused unless explicitly pinned:
python3 /absolute/external/operator.py prepare RELEASE MANIFEST_SHA256 --expected-operator-sha256 OPERATOR_SHA256 --expected-candidate-image-id sha256:FULL_IMAGE_ID
python3 /absolute/external/operator.py activate RELEASE MANIFEST_SHA256 --expected-operator-sha256 OPERATOR_SHA256 --allow-session-reset
python3 /absolute/external/operator.py rollback RELEASE MANIFEST_SHA256 --expected-operator-sha256 OPERATOR_SHA256 --allow-session-reset
```

Prepare checks the supplied live `.env`/Compose hashes, accepted baseline release
and image, accepted overlay base image, resources, root, deployment lock inode,
neighbor containers, authentication-file identity/ACL and readable access as
101:101. The production password file is never read by the operator or access
probe. Prepare builds only the fixed network-disabled overlay. Its runtime image
config and base-layer prefix must match the pinned base image. Exact runtime file
hashes and inventory are checked independently inside the candidate.

The candidate has no external network, uses a random ephemeral password/hash,
and tests game `http://127.0.0.1:5173` and spectator `http://localhost:5173` hosts.
Both exercise login and exact authenticated assets; spectator also tests `?spec=1`,
protected anonymous bundle denial, blocked room/join/invite/leave APIs, metrics,
and WebSocket upgrade rejection. Production-origin activation probes use no
production credentials; the parent must perform the real authenticated edge
acceptance separately. Preparation receipts pin both old and intended new config
hashes and the exact baseline container state.

Activation consumes an exclusive rollback directory before writing. It backs up
both originals and records both old/new hash pairs durably first. Its only content
changes are `CAR_RELEASE=old` to the new release and the following exact LF line
immediately after the sole existing six-space `CAR_ORIGIN:` line:

```yaml
      CAR_SPECTATOR_ORIGIN: https://carspectator.spatterson.ca
```

Config owner/group, mode and Linux ACL/xattrs are copied and verified on atomic
replacement. Authentication file and neighbors must retain their original
metadata/state. Compose configuration must validate before every recreate.
Recreates are exclusively `docker compose --project-name car-soccer ... up -d
--no-deps --no-build --pull never --wait --wait-timeout 60 car-soccer`.

A completed rollback writes an exclusive completion receipt and cannot be replayed
for an additional session reset. An interrupted rollback without that receipt can
be retried with the same pinned operator and record. Rollback verifies the original image pin and both backup hashes. Before either
write, each current config must independently match its recorded old or new hash;
all four old/new combinations are supported, including interruptions between the
two writes. It restores **both** originals and validates Compose before recreating
only this app. Unknown edits, unsafe file types, changed root/lock, altered image
pins or altered neighbor/authentication state fail closed. Keep `rollback/`, its
`record.json`, both root config originals and the baseline image intact. A failed
restore or unknown current file requires parent inspection; do not delete the
exclusive activation directory or loosen guards to retry.

## Verification boundaries

The local unittest suite uses synthetic files and fake Docker responses; it
covers exact config transformations, injected activation failures immediately after
each config write, durable backup/hash ordering, ambiguous/unknown config refusal, all four
partial-write recovery combinations, tampered backups, unsafe file links and
Compose validation ordering/scope. Linux xattrs are modeled in the macOS test
harness; real Linux ACL behavior, Docker, image layers, production access, resource
headroom, and browser/device/multiplayer behavior still require the parent's
independent host review and acceptance. No package build or host action is run
while these tools remain uncommitted.
