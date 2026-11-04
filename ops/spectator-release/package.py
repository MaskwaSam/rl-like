#!/usr/bin/env python3
"""Build and freeze a clean committed spectator candidate; no upload or activation."""
from pathlib import Path, PurePosixPath
import argparse
import hashlib
import json
import shutil
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[2]
BASE_TAG = 'car-soccer-private:20261003T224415Z-9bd5cb33108a-8cb0e27bcd04'
OUTPUTS = ('dist', '.server-build')
BASELINE_SOURCE_COMMIT = 'c825a5e2fe928f6101dc8a949db8ea6c7a64d3bb'
APPROVED_SOURCE_FILES = {
    '.github/workflows/deploy.yml',
    '.gitignore',
    'deploy/DEPLOYMENT-2026-09-30.md',
    'deploy/Dockerfile',
    'deploy/README.md',
    'deploy/compose.yaml',
    'deploy/nginx.conf',
    'docs/verification/2026-10-25-live-multiplayer.md',
    'docs/verification/2026-11-03-spectator-edge-cases.md',
    'docs/verification/2026-11-04-spectator-edge-fixes-browser.json',
    'docs/verification/2026-11-04-spectator-edge-fixes.md',
    'docs/verification/images/2026-10-25-finished-match.jpg',
    'docs/verification/images/2026-10-25-retry-kickoff.jpg',
    'docs/verification/images/2026-10-25-retry-movement.jpg',
    'ops/spectator-release/README.md',
    'ops/spectator-release/operator.py',
    'ops/spectator-release/package.py',
    'ops/spectator-release/test_release.py',
    'package.json',
    'qa/host-startup.ts',
    'qa/run-headless.mjs',
    'qa/run-host-startup.mjs',
    'qa/run-spectator-admission.mjs',
    'qa/run-spectator-host.mjs',
    'qa/spectator-admission-test.ts',
    'qa/spectator-browser.mjs',
    'qa/spectator-host.ts',
    'qa/spectators.ts',
    'qa/transport-regression.mjs',
    'server/README.md',
    'server/compose.example.yml',
    'server/index.ts',
    'src/access.ts',
    'src/net/client.ts',
    'src/net/host.ts',
    'src/net/protocol.ts',
    'src/net/session.ts',
    'src/net/spectator-admission.ts',
    'src/net/spectator.ts',
    'src/net/transport.ts',
    'src/spectator/cameras.ts',
    'src/spectator/main.ts',
    'src/spectator/spectator.css',
    'src/ui/menu.ts',
}


TURN_SHA256 = 'f7fafc6bc449e675e25e59fbde2ebb3b2cf8e60d5d301ffbf6fe2f1dfc83ddab'

def file_digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def git(*args, data=None):
    return subprocess.check_output(['git', *args], cwd=ROOT, input=data)


def clean_head(expected=None):
    require(not git('status', '--porcelain', '--untracked-files=all').strip(), 'Source checkout must be clean')
    head = git('rev-parse', 'HEAD').decode().strip()
    require(expected is None or head == expected, 'Source HEAD changed during packaging')
    return head


def tracked_files(commit):
    result = {}
    for entry in git('ls-tree', '-rz', '--full-tree', commit).split(b'\0'):
        if not entry:
            continue
        metadata, raw_path = entry.split(b'\t', 1)
        mode, kind, oid = metadata.decode().split()
        require(kind == 'blob' and mode in {'100644', '100755'}, 'Source links/submodules are not supported')
        name = raw_path.decode('utf-8')
        result[name] = (mode, oid)
    return result


def verify_worktree(commit, tracked):
    clean_head(commit)
    for name, (mode, oid) in tracked.items():
        path = ROOT / name
        require(path.is_file() and not path.is_symlink(), 'Unsafe tracked source file: ' + name)
        for parent in path.parents:
            if parent == ROOT:
                break
            require(not parent.is_symlink(), 'Source parent symlink: ' + name)
        if name == 'public/turn.json':
            require(path.stat().st_size == 1006 and file_digest(path) == TURN_SHA256, 'Relay config hash changed')
            require(git('rev-parse', commit + ':public/turn.json') == git('rev-parse', BASELINE_SOURCE_COMMIT + ':public/turn.json'), 'Relay blob changed')
        else:
            expected = git('cat-file', 'blob', oid)
            require(path.read_bytes() == expected, 'Tracked source differs from HEAD: ' + name)
        require(bool(path.stat().st_mode & 0o111) == (mode == '100755'), 'Source executable mode differs: ' + name)


def remove_build_output(name):
    require(name in OUTPUTS, 'Unexpected build output path')
    path = ROOT / name
    require(ROOT.is_dir() and not ROOT.is_symlink() and ROOT.resolve() == ROOT, 'Unexpected source root')
    if not path.exists() and not path.is_symlink():
        return
    require(path.is_dir() and not path.is_symlink(), 'Build output must be a real directory: ' + name)
    # Refuse links/special files rather than follow them during cleanup or copying.
    for item in path.rglob('*'):
        require(not item.is_symlink() and (item.is_dir() or item.is_file()), 'Unsafe build output member')
    shutil.rmtree(path)  # Only the two exact, reviewed ignored build directories.


def regular_inventory(root):
    require(root.is_dir() and not root.is_symlink(), 'Inventory root must be a real directory')
    result = {}
    for path in sorted(root.rglob('*')):
        require(not path.is_symlink() and (path.is_file() or path.is_dir()), 'Unsafe package member')
        if path.is_file():
            result[path.relative_to(root).as_posix()] = {'sha256': file_digest(path), 'bytes': path.stat().st_size}
    return result


def safe_tar_files(archive):
    result = {}
    for member in archive.getmembers():
        name = member.name.rstrip('/')
        require(name and not name.startswith('/') and '..' not in PurePosixPath(name).parts and PurePosixPath(name).as_posix() == name, 'Unsafe archive path')
        require(member.isdir() or member.isfile(), 'Archive links/special files are not supported')
        if member.isdir():
            continue
        require(name not in result, 'Duplicate archive file')
        result[name] = (member.mode, archive.extractfile(member).read())
    return result


def verify_source_archive(path, commit, tracked):
    embedded = git('get-tar-commit-id', data=path.read_bytes()).decode().strip()
    require(embedded == commit, 'Source archive commit does not match frozen HEAD')
    with tarfile.open(path, 'r:') as archive:
        files = safe_tar_files(archive)
    require(set(files) == set(tracked), 'Source archive tracked inventory mismatch')
    for name, (mode, oid) in tracked.items():
        exported_mode, exported_data = files[name]
        if name == 'public/turn.json':
            require(len(exported_data) == 1006 and hashlib.sha256(exported_data).hexdigest() == TURN_SHA256, 'Archived relay hash changed')
        else:
            require(exported_data == git('cat-file', 'blob', oid), 'Exported source differs from HEAD: ' + name)
        require(bool(exported_mode & 0o111) == (mode == '100755'), 'Exported executable mode differs: ' + name)


def verify_approved_delta(commit):
    git('merge-base', '--is-ancestor', BASELINE_SOURCE_COMMIT, commit)
    require(not git('diff', BASELINE_SOURCE_COMMIT, commit, '--', 'package-lock.json'), 'Runtime dependency lock changed')
    old_package = json.loads(git('show', BASELINE_SOURCE_COMMIT + ':package.json'))
    new_package = json.loads(git('show', commit + ':package.json'))
    require(all(old_package.get(key) == new_package.get(key) for key in ('dependencies', 'devDependencies', 'optionalDependencies', 'overrides', 'engines')), 'Dependency declarations changed')
    changed = {name.decode() for name in git('diff', '--name-only', '-z', '--no-renames', BASELINE_SOURCE_COMMIT, commit).split(b'\0') if name}
    require(changed == APPROVED_SOURCE_FILES, 'spectator source delta must match the reviewed spectator files exactly')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--expected-source-commit', required=True, help='Exact reviewed, committed 40-character source SHA')
    parser.add_argument('--output-parent', type=Path, help='Existing absolute local staging parent; default system temporary directory')
    args = parser.parse_args()
    import tempfile
    output_parent = args.output_parent or Path(tempfile.gettempdir())
    require(output_parent.is_absolute() and output_parent.is_dir() and not output_parent.is_symlink(), 'Output parent must be an existing absolute real directory')
    output_parent = output_parent.resolve()
    if output_parent == ROOT or ROOT in output_parent.parents:
        rel = output_parent.relative_to(ROOT).as_posix() + '/'
        require(git('check-ignore', '--', rel).strip(), 'In-repository output parent must be ignored')
    require(len(args.expected_source_commit) == 40 and all(c in '0123456789abcdef' for c in args.expected_source_commit), 'Expected source commit must be a full SHA')
    commit = clean_head(args.expected_source_commit)
    verify_approved_delta(commit)
    tracked = tracked_files(commit)
    verify_worktree(commit, tracked)
    release = '20261104-spectator-' + commit[:12]
    stage = output_parent / release
    archive_path = output_parent / (release + '.tar.gz')
    require(not stage.exists() and not stage.is_symlink() and not archive_path.exists() and not archive_path.is_symlink(), 'Release packet already exists')
    for name in OUTPUTS:
        require(git('check-ignore', '--', name + '/').strip(), 'Build output is not explicitly ignored: ' + name)
        require(not any(p == name or p.startswith(name + '/') for p in tracked), 'Refusing cleanup of tracked output')
        remove_build_output(name)
    subprocess.run(['npm', 'run', 'build'], cwd=ROOT, check=True)
    verify_worktree(commit, tracked)
    subprocess.run(['npm', 'run', 'server:build'], cwd=ROOT, check=True)
    verify_worktree(commit, tracked)
    output_inventories = {name: regular_inventory(ROOT / name) for name in OUTPUTS}
    require(all(output_inventories.values()), 'Fresh build produced missing or empty output')
    stage.mkdir(exist_ok=False)
    for name in OUTPUTS:
        shutil.copytree(ROOT / name, stage / name)
        require(regular_inventory(stage / name) == output_inventories[name], 'Copied build output differs: ' + name)
    identity = {'release': release, 'source_commit': commit, 'baseline_source_commit': 'c825a5e2fe928f6101dc8a949db8ea6c7a64d3bb',
                'build_stamp': f'v0.1.0 · {commit[:7]} · ' + git('log', '-1', '--format=%cI', commit).decode().strip()[:16].replace('T', ' '), 'private_rooms': True, 'admin_included': False, 'lan_default': True}
    (stage / 'dist/release.json').write_text(json.dumps(identity, indent=2) + '\n')
    subprocess.run(['git', 'archive', '--format=tar', '-o', str(stage / 'source.tar'), commit], cwd=ROOT, check=True)
    verify_source_archive(stage / 'source.tar', commit, tracked)
    (stage / 'Dockerfile.lan').write_text('FROM ' + BASE_TAG + '\nUSER 0:0\nRUN rm -rf /app/dist /app/.server-build\nCOPY --chown=101:101 dist/ /app/dist/\nCOPY --chown=101:101 .server-build/ /app/.server-build/\nUSER 101:101\n')
    (stage / '.dockerignore').write_text('source.tar\nmanifest.json\n')
    verify_worktree(commit, tracked)
    require(all(regular_inventory(ROOT / name) == output_inventories[name] for name in OUTPUTS), 'Build outputs changed during packaging')
    inventory = regular_inventory(stage)
    files = [{'path': name, **entry} for name, entry in sorted(inventory.items())]
    (stage / 'manifest.json').write_text(json.dumps({'identity': identity, 'files': files,
        'scope': 'Exact reviewed spectator delta; dependency lock unchanged',
        'source_paths': sorted(tracked), 'approved_delta': sorted(APPROVED_SOURCE_FILES),
        'build_outputs': output_inventories, 'operator_sha256': hashlib.sha256((ROOT / 'ops/spectator-release/operator.py').read_bytes()).hexdigest()}, indent=2) + '\n')
    expected = regular_inventory(stage)
    with tarfile.open(archive_path, 'x:gz') as archive:
        for name in expected:
            archive.add(stage / name, arcname=name, recursive=False)
    # Re-open the completed archive independently, then compare exact inventory and bytes.
    with tarfile.open(archive_path, 'r:gz') as archive:
        restored = safe_tar_files(archive)
    require(set(restored) == set(expected), 'Final archive inventory mismatch')
    for name, (_, data) in restored.items():
        require({'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)} == expected[name], 'Final archive bytes differ: ' + name)
    require(regular_inventory(stage) == expected, 'Staged packet changed after archive write')
    verify_worktree(commit, tracked)
    receipt = {'release': release, 'source_commit': commit, 'manifest_sha256': hashlib.sha256((stage / 'manifest.json').read_bytes()).hexdigest(),
               'archive': str(archive_path), 'archive_sha256': hashlib.sha256(archive_path.read_bytes()).hexdigest(),
               'bytes': archive_path.stat().st_size, 'stage': str(stage)}
    with (output_parent / (release + '-receipt.json')).open('x') as stream:
        stream.write(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt, indent=2))


if __name__ == '__main__':
    main()
