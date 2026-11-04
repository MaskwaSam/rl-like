#!/usr/bin/env python3
"""Bounded remote Car Soccer release operator. Never run this on a workstation.
Usage: python3 release_operator.py prepare|activate|rollback RELEASE MANIFEST_SHA256
Activation and rollback additionally require --allow-session-reset.
The digest binds manifest.json bytes, which in turn bind every package file.
"""
import argparse
import fcntl
import grp
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import shutil
import stat
import subprocess
import sys
import time

ROOT = Path('/home/sam/services/car-soccer')
BASE_TAG = 'car-soccer-private:20261003T224415Z-9bd5cb33108a-8cb0e27bcd04'
BASE_ID = 'sha256:437a58fabdbc431d6b6a8f83f80145caa3431472a2b4df5be5677998b5ef0ce9'
BASELINE_RELEASE = '20261104-spectator-8c9a197033bc'
EXPECTED_CONFIG = {'env_sha256': '46224dfc43086a278ec0ded6252ffc7ab8022297c6966e18596baf36ef11f920', 'compose_sha256': '797e82d12efebcb4bd668654794ab5acb101f1e58f12263a116ebbb35ee098d8'}
BASELINE_TAG = 'car-soccer-private:' + BASELINE_RELEASE
BASELINE_IMAGE_ID = 'sha256:41b3fe3554c10515b739d76f00357fb088485a2ec153cdfc690480e4dbfddcf4'
BASELINE_SOURCE_COMMIT = '8c9a197033bc5581738347beea2dbb60911431fc'
COMPOSE = ['docker', 'compose', '--project-name', 'car-soccer', '--env-file', str(ROOT / '.env'), '-f', str(ROOT / 'compose.yaml')]


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


ROOT_IDENTITY = None
LOCK_IDENTITY = None
LOCK_FD = None

def guard_root():
    if ROOT_IDENTITY is not None:
        safe(ROOT, True)
        require(ROOT.resolve() == ROOT and (ROOT.stat().st_dev, ROOT.stat().st_ino) == ROOT_IDENTITY, 'Deployment root identity changed')
        require(safe_lock(ROOT / 'deployment.lock', LOCK_FD) == LOCK_IDENTITY, 'Deployment lock identity changed')

def run(args, data=None, timeout=90):
    guard_root()
    p = subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    require(p.returncode == 0, 'Command failed: ' + ' '.join(args[:3]) + ' (output suppressed)')
    return p.stdout


def inspect(kind, name):
    return json.loads(run(['docker', kind, 'inspect', name]))[0]


def exists(kind, name):
    return subprocess.run(['docker', kind, 'inspect', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def safe(path, directory=False):
    s = path.lstat()
    require(not stat.S_ISLNK(s.st_mode), 'Symlink refused: ' + path.name)
    require(s.st_uid == os.getuid(), 'Unexpected ownership: ' + path.name)
    require(stat.S_ISDIR(s.st_mode) if directory else stat.S_ISREG(s.st_mode), 'Unexpected file type: ' + path.name)
    require(s.st_nlink == 1 or directory, 'Hardlinked file refused: ' + path.name)
    require(not s.st_mode & 0o022, 'Writable by another account: ' + path.name)
    return s


def safe_lock(path, fd):
    """Validate the shared lock without replacing its inode or changing its mode."""
    opened = os.fstat(fd)
    named = path.lstat()
    require((opened.st_dev, opened.st_ino) == (named.st_dev, named.st_ino), 'Deployment lock path changed')
    require(stat.S_ISREG(opened.st_mode) and not stat.S_ISLNK(named.st_mode), 'Unexpected deployment lock type')
    require(opened.st_uid == os.getuid() and opened.st_nlink == 1, 'Unexpected deployment lock ownership or link count')
    require(not opened.st_mode & 0o002, 'Deployment lock is writable by another account')
    if opened.st_mode & 0o020:
        require(opened.st_gid == os.getgid(), 'Deployment lock group differs from current primary group')
        username = pwd.getpwuid(os.getuid()).pw_name
        require(set(grp.getgrgid(opened.st_gid).gr_mem) <= {username}, 'Deployment lock group has other members')
        primary_users = {user.pw_name for user in pwd.getpwall() if user.pw_gid == opened.st_gid}
        require(primary_users <= {username}, 'Deployment lock group is primary for another account')
    fields = lambda s: (s.st_dev, s.st_ino, s.st_uid, s.st_gid, s.st_mode, s.st_nlink)
    require(fields(opened) == fields(named), 'Deployment lock metadata changed')
    return fields(opened)


def write_json(path, value):
    guard_root()
    require(not path.exists(), 'Record already exists: ' + path.name)
    data = (json.dumps(value, indent=2, sort_keys=True) + '\n').encode()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try: os.fsync(directory)
    finally: os.close(directory)



SPECTATOR_LINE = b'      CAR_SPECTATOR_ORIGIN: https://carspectator.spatterson.ca\n'

def config_delta(env, compose, release):
    require(re.fullmatch(r'20261104-spectator-[0-9a-f]{12}', release), 'Invalid spectator release')
    matches = list(re.finditer(rb'(?m)^CAR_RELEASE=([^\r\n]*)$', env))
    require(len(matches) == 1 and matches[0].group(1).decode() == BASELINE_RELEASE, 'Unexpected CAR_RELEASE setting')
    lines = compose.splitlines(keepends=True)
    require(compose.count(b'CAR_SPECTATOR_ORIGIN') == 1 and lines.count(SPECTATOR_LINE) == 1, 'Expected one exact spectator origin line')
    game_line = b'      CAR_ORIGIN: https://car.spatterson.ca\n'
    require(compose.count(b'CAR_ORIGIN') == 1 and lines.count(game_line) == 1, 'Expected one exact game origin line')
    m = matches[0]
    return env[:m.start(1)] + release.encode() + env[m.end(1):], compose


def validate_restore_configs(record):
    # Admit every partial old/new pair, reject unrelated edits before either write.
    for name, key in [('.env', 'env_sha256'), ('compose.yaml', 'compose_sha256')]:
        safe(ROOT / name)
        require(sha(ROOT / name) in {record[key], record['activated_' + key]}, 'Unknown current configuration; rollback refused: ' + name)


def atomic_config(path, data, metadata_source=None):
    guard_root()
    source = metadata_source or path
    safe(path)
    safe(source)
    st = source.stat()
    attrs = {key: os.getxattr(source, key) for key in os.listxattr(source)}
    temp = path.with_name(path.name + '.release-' + secrets.token_hex(6))
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
        os.chown(temp, st.st_uid, st.st_gid)
        os.chmod(temp, stat.S_IMODE(st.st_mode))
        for key, value in attrs.items():
            os.setxattr(temp, key, value)
        ts = temp.stat()
        require((ts.st_uid, ts.st_gid, stat.S_IMODE(ts.st_mode)) == (st.st_uid, st.st_gid, stat.S_IMODE(st.st_mode)), 'Config metadata copy failed')
        require({key: os.getxattr(temp, key) for key in os.listxattr(temp)} == attrs, 'Config ACL/xattrs copy failed')
        os.replace(temp, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(directory)
        finally: os.close(directory)
    finally:
        if temp.exists(): temp.unlink()


def file_security(p):
    st = safe(p)
    return {'uid': st.st_uid, 'gid': st.st_gid, 'mode': stat.S_IMODE(st.st_mode),
            'xattrs': {k: hashlib.sha256(os.getxattr(p, k)).hexdigest() for k in os.listxattr(p)}}

def config_identities():
    return {name: (safe(ROOT / name).st_dev, safe(ROOT / name).st_ino) for name in ('.env', 'compose.yaml')}

def config_metadata():
    return {name: file_security(ROOT / name) for name in ('.env', 'compose.yaml')}


def config_hashes():
    for p in [ROOT / '.env', ROOT / 'compose.yaml']:
        safe(p)
    return {'env_sha256': sha(ROOT / '.env'), 'compose_sha256': sha(ROOT / 'compose.yaml')}


def snapshot(c):
    # Explicit allowlist: never serialize Config.Env, command arguments or logs.
    h = c['HostConfig']
    return {'id': c['Id'], 'image_id': c['Image'], 'running': c['State']['Running'],
            'started_at': c['State']['StartedAt'], 'restart_count': c['RestartCount'],
            'networks': {n: {'id': v['NetworkID'], 'aliases': v.get('Aliases')} for n, v in c['NetworkSettings']['Networks'].items()},
            'user': c['Config']['User'], 'readonly': h['ReadonlyRootfs'], 'memory': h['Memory'],
            'nano_cpus': h['NanoCpus'], 'pids_limit': h['PidsLimit'], 'cap_drop': h.get('CapDrop'),
            'security_opt': h.get('SecurityOpt'), 'ports': h.get('PortBindings'),
            'mounts': sorted([{'type': m['Type'], 'source': m['Source'], 'destination': m['Destination'], 'rw': m['RW']} for m in c['Mounts']],
                             key=lambda m: (m['destination'], m['source'], m['type'], m['rw']))}


def neighbors():
    ids = run(['docker', 'ps', '-aq']).decode().split()
    result = {}
    for cid in ids:
        c = inspect('container', cid)
        name = c['Name'].lstrip('/')
        if name != 'car-soccer' and not name.startswith('car-soccer-candidate-'):
            result[name] = snapshot(c)
    require('spatterson-cloudflared' in result, 'Shared connector missing')
    return result


def live(expected_id=None, require_running=True):
    c = inspect('container', 'car-soccer')
    s = snapshot(c)
    if expected_id:
        require(s['id'] == expected_id, 'Live container changed since preparation')
    require(not require_running or s['running'], 'Live service is not running')
    require(s['user'] == '101:101' and s['readonly'] and s['memory'] == 512 * 1024**2 and s['nano_cpus'] == 10**9 and s['pids_limit'] == 64, 'Unexpected live resource/security settings')
    require('ALL' in (s['cap_drop'] or []) and any(x.startswith('no-new-privileges') for x in s['security_opt'] or []), 'Unexpected live security options')
    require(not s['ports'] and set(s['networks']) == {'car_soccer_edge'}, 'Unexpected live ports/networks')
    expected = [{'type': 'bind', 'source': str(ROOT / 'secrets/game-password-hash'), 'destination': '/run/secrets/game-password-hash', 'rw': False}]
    require(s['mounts'] == expected, 'Unexpected live authentication mount')
    return c



def recovery_state(record):
    # A successful Docker list distinguishes confirmed absence from daemon/inspect failure.
    ids = run(['docker', 'ps', '-aq', '--no-trunc', '--filter', 'name=^/car-soccer$']).decode().split()
    require(len(ids) <= 1, 'Ambiguous Car Soccer recovery identity')
    if not ids:
        return None
    c = live(require_running=False)  # retain all security/mount/network guards
    require(c['Id'] == ids[0], 'Recovery container changed during inspection')
    require(c['Image'] in {record['image_id'], record['baseline_image_id']}, 'Live image changed; rollback refused')
    return c


def package(release, digest):
    safe(ROOT / 'releases', True)
    stage = ROOT / 'releases' / release
    safe(stage, True)
    safe(stage / 'manifest.json')
    require(sha(stage / 'manifest.json') == digest, 'Manifest digest mismatch')
    m = json.loads((stage / 'manifest.json').read_bytes())
    require(re.fullmatch(r'20261104-spectator-[0-9a-f]{12}', release), 'Unexpected spectator release namespace')
    require(m['operator_sha256'] == sha(Path(__file__)), 'Package operator digest mismatch')
    require(m['identity']['baseline_source_commit'] == BASELINE_SOURCE_COMMIT, 'Unexpected package source baseline')
    require(m['identity']['release'] == release and re.fullmatch(r'[0-9a-f]{40}', m['identity']['source_commit']), 'Invalid package identity')
    require(release == '20261104-spectator-' + m['identity']['source_commit'][:12], 'Release/source identity mismatch')
    paths = set()
    for entry in m['files']:
        rel = entry['path']
        require(isinstance(rel, str) and rel and not rel.startswith('/') and '..' not in Path(rel).parts and rel == Path(rel).as_posix() and rel != 'manifest.json' and rel not in paths, 'Unsafe or duplicate manifest path')
        paths.add(rel)
        p = stage / rel
        for parent in p.parents:
            if parent == stage:
                break
            safe(parent, True)
        safe(p)
        require(p.stat().st_size == entry['bytes'] and sha(p) == entry['sha256'], 'Package file mismatch: ' + rel)
    actual = set()
    for p in stage.rglob('*'):
        safe(p, p.is_dir())
        if p.is_file():
            actual.add(p.relative_to(stage).as_posix())
    require(actual == paths | {'manifest.json'}, 'Unmanifested or missing package files')
    require({'Dockerfile.lan', 'dist/release.json'} <= paths and any(x.startswith('.server-build/') for x in paths), 'Missing release artifacts')
    # Only this overlay is allowed; no dependency installation or general shell commands.
    lines = [x.strip() for x in (stage / 'Dockerfile.lan').read_text().splitlines() if x.strip() and not x.strip().startswith('#')]
    require(lines == ['FROM ' + BASE_TAG, 'USER 0:0',
                      'RUN rm -rf /app/dist /app/.server-build',
                      'COPY --chown=101:101 dist/ /app/dist/',
                      'COPY --chown=101:101 .server-build/ /app/.server-build/',
                      'USER 101:101'], 'Unexpected Dockerfile overlay instructions')
    require('dist/.vite/manifest.json' in paths, 'Missing Vite manifest')
    vite = json.loads((stage / 'dist/.vite/manifest.json').read_bytes())
    protected = 'dist/' + vite['src/main.ts']['file']
    require(protected in paths and protected.endswith('.js'), 'Missing protected game bundle')
    assets = [{**e, 'protected': e['path'] == protected,
               'internal': any(part.startswith('.') for part in Path(e['path']).parts[1:])}
              for e in m['files'] if e['path'].startswith('dist/')]
    return stage, m, assets


# Independent HTTP client: receives only synthetic test credentials in prepare.
PROBE = r'''
const http=require('node:http'), crypto=require('node:crypto');
let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',async()=>{
try { const cfg=JSON.parse(input), host=cfg.host, origin=cfg.origin; let cookie='';
const get=(path,body,auth=true)=>new Promise((resolve,reject)=>{const b=body===undefined?null:JSON.stringify(body);
const q=http.request({host:'127.0.0.1',port:cfg.port,path,method:b?'POST':'GET',headers:{Host:host,Origin:origin,...(b?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(b)}:{}),...(auth&&cookie?{Cookie:cookie}:{})}},r=>{let a=[];r.on('data',x=>a.push(x));r.on('end',()=>resolve({status:r.statusCode,headers:r.headers,bytes:Buffer.concat(a)}));});q.setTimeout(8000,()=>q.destroy(new Error('timeout')));q.on('error',reject);q.end(b);});
const check=(x,s)=>{if(!x)throw new Error(s)};
let r=await get('/healthz');check(r.status===200&&JSON.parse(r.bytes).ok,'health');if(cfg.readiness){process.stdout.write('ready\n');return;}
r=await get('/release.json');check(r.status===200&&crypto.createHash('sha256').update(r.bytes).digest('hex')===cfg.releaseHash,'release');
r=await get('/');check(r.status===200,'gate');
const bundle=cfg.assets.find(x=>x.protected);check(bundle,'protected bundle missing');
if(cfg.spectator){r=await get('/?spec=1');check(r.status===200,'spectator gate');}
r=await get('/'+bundle.path.slice(5),undefined,false);check(r.status===401,'anonymous bundle');
r=await get('/game/status');check(JSON.parse(r.bytes).access==='none','anonymous status');
if(cfg.password){
r=await get('/game/login',{password:cfg.password+'-wrong'});check(r.status===401,'incorrect password');
r=await get('/game/login',{password:cfg.password});check(r.status===200,'login');cookie=(r.headers['set-cookie']||[]).map(x=>x.split(';')[0]).join('; ');check(cookie,'session cookie');
if(cfg.spectator){r=await get('/?spec=1');const entry=cfg.assets.find(a=>a.path==='dist/index.html');check(entry&&r.status===200&&crypto.createHash('sha256').update(r.bytes).digest('hex')===entry.sha256,'authenticated spectator entry');}
for(const a of cfg.assets){r=await get('/'+a.path.slice(5));if(a.internal){check(r.status===404,'internal file exposed');continue;}check(r.status===200&&r.bytes.length===a.bytes&&crypto.createHash('sha256').update(r.bytes).digest('hex')===a.sha256,'asset');}
if(cfg.spectator){
for(const path of ['/game/rooms','/game/join','/game/invite','/game/leave']){r=await get(path,{teamSize:1});check(r.status===404,'spectator blocked API');}
r=await get('/game/metrics');check(r.status===404,'spectator metrics');
await new Promise((resolve,reject)=>{const q=http.request({host:'127.0.0.1',port:cfg.port,path:'/game/ws',headers:{Host:host,Origin:origin,Cookie:cookie,Connection:'Upgrade',Upgrade:'websocket','Sec-WebSocket-Version':'13','Sec-WebSocket-Key':crypto.randomBytes(16).toString('base64')}},r=>{r.resume();check(r.statusCode===403,'spectator upgrade');resolve();});q.on('upgrade',(_,socket)=>{socket.destroy();reject(Error('spectator upgraded'));});q.on('error',reject);q.setTimeout(8000,()=>q.destroy(Error('timeout')));q.end();});
}else{r=await get('/game/rooms',{teamSize:1});check(r.status===201||r.status===200,'create room');const room=JSON.parse(r.bytes);check(room.id||room.roomId,'room identity');}
} process.stdout.write('probe passed\n');
}catch(e){process.stderr.write('HTTP probe failed\n');process.exitCode=1;}});
'''


def probe(cid, assets, synthetic=None, readiness=False, spectator=False):
    # Fixed, reviewed endpoints. Never inspect or parse container environment values.
    origin = 'http://127.0.0.1:5173' if synthetic or readiness else 'https://car.spatterson.ca'
    if spectator:
        origin = 'http://localhost:5173' if synthetic else 'https://carspectator.spatterson.ca'
    from urllib.parse import urlsplit
    data = {'host': urlsplit(origin).netloc, 'origin': origin, 'assets': assets, 'port': 8080, 'readiness': readiness, 'spectator': spectator,
            'releaseHash': next(a['sha256'] for a in assets if a['path'] == 'dist/release.json')}
    if synthetic:
        data['password'] = synthetic
    run(['docker', 'exec', '-i', cid, 'node', '-e', PROBE], json.dumps(data).encode(), timeout=90)


def secret_metadata():
    p = ROOT / 'secrets/game-password-hash'
    require(not (ROOT / 'secrets').is_symlink() and (ROOT / 'secrets').is_dir() and not p.is_symlink() and p.is_file(), 'Authentication source changed type')
    s = p.stat()
    # Linux POSIX ACLs are stored as xattrs; fingerprint metadata, never secret bytes.
    attrs = {key: hashlib.sha256(os.getxattr(p, key)).hexdigest() for key in os.listxattr(p)}
    return {'device': s.st_dev, 'inode': s.st_ino, 'uid': s.st_uid, 'gid': s.st_gid,
            'mode': stat.S_IMODE(s.st_mode), 'size': s.st_size,
            'mtime_ns': s.st_mtime_ns, 'ctime_ns': s.st_ctime_ns, 'xattr_hashes': attrs}


FILE_PROBE = r"""
const fs=require('node:fs'),crypto=require('node:crypto');let input='';
process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{try{
const expected=JSON.parse(input),actual=[];
function walk(path){for(const name of fs.readdirSync('/app/'+path)){
const rel=path+'/'+name,st=fs.lstatSync('/app/'+rel);
if(st.isSymbolicLink())throw Error('symlink');
if(st.isDirectory())walk(rel);else if(st.isFile())actual.push(rel);else throw Error('file type');}}
walk('dist');walk('.server-build');
if(JSON.stringify(actual.sort())!==JSON.stringify(expected.map(x=>x.path).sort()))throw Error('inventory');
for(const e of expected){const b=fs.readFileSync('/app/'+e.path);if(b.length!==e.bytes||crypto.createHash('sha256').update(b).digest('hex')!==e.sha256)throw Error('digest');}
process.stdout.write('candidate file inventory and hashes passed\n');
}catch(e){process.stderr.write('Candidate file verification failed\n');process.exitCode=1;}});
"""


def candidate_files(cid, manifest):
    entries = [entry for entry in manifest['files'] if entry['path'].startswith(('dist/', '.server-build/'))]
    require(any(e['path'].startswith('.server-build/') for e in entries), 'Missing server files')
    run(['docker', 'exec', '-i', cid, 'node', '-e', FILE_PROBE], json.dumps(entries).encode(), timeout=90)


def preservation(release, digest, baseline, before, auth_metadata, config):
    prior = {'live': snapshot(baseline), 'neighbors': before, 'auth_metadata': auth_metadata, 'config': config}
    current, errors = {}, {}
    readers = {'live': lambda: snapshot(live()), 'neighbors': neighbors,
               'auth_metadata': secret_metadata, 'config': config_hashes}
    for name, read in readers.items():
        try:
            current[name] = read()
        except Exception as exc:
            current[name] = None
            errors[name] = type(exc).__name__
    checks = {name: current[name] == value for name, value in prior.items()}
    if not all(checks.values()):
        diagnostic = ROOT / 'receipts' / ('preparation-failed-' + release + '-' + time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + secrets.token_hex(3) + '.json')
        changed_neighbors = sorted(name for name in set(before) | set(current.get('neighbors') or {})
                                   if before.get(name) != (current.get('neighbors') or {}).get(name))
        write_json(diagnostic, {'release': release, 'manifest_sha256': digest, 'checks': checks,
                              'changed_neighbors': changed_neighbors, 'read_errors': errors,
                              'prior': prior, 'current': current})
        raise RuntimeError('Preparation preservation checks failed; sanitized diagnostic: ' + diagnostic.name)


def headroom():
    require(shutil.disk_usage(ROOT).free >= 1024**3, 'Less than 1 GiB disk headroom')
    available = next(int(x.split()[1]) * 1024 for x in Path('/proc/meminfo').read_text().splitlines() if x.startswith('MemAvailable:'))
    require(available >= 1024**3, 'Less than 1 GiB memory headroom')


def prepare(release, digest, receipt_path, expected_candidate_image_id=None):
    require(not receipt_path.exists(), 'Release already prepared')
    stage, manifest, assets = package(release, digest)
    require(inspect('image', BASE_TAG)['Id'] == BASE_ID, 'Accepted base tag changed')
    baseline = live()
    require(inspect('image', BASELINE_TAG)['Id'] == BASELINE_IMAGE_ID, 'Deployment baseline image tag changed')
    require(baseline['Image'] == BASELINE_IMAGE_ID, 'Live image is not accepted deployment baseline')
    before = neighbors()
    auth_metadata = secret_metadata()
    config = config_hashes()
    config_security = config_metadata()
    config_identity = config_identities()
    require(config == EXPECTED_CONFIG, 'Configuration differs from verified baseline')
    updated_env, updated_compose = config_delta((ROOT / '.env').read_bytes(), (ROOT / 'compose.yaml').read_bytes(), release)
    activated_config = {'activated_env_sha256': hashlib.sha256(updated_env).hexdigest(), 'activated_compose_sha256': hashlib.sha256(updated_compose).hexdigest()}
    auth_access(BASELINE_IMAGE_ID)
    headroom()
    tag = 'car-soccer-private:' + release
    name = 'car-soccer-candidate-' + release
    require(not exists('container', name), 'Candidate name already used')
    if exists('image', tag):
        require(expected_candidate_image_id is not None, 'Existing release image requires explicit expected candidate image ID')
        image = inspect('image', tag)
        require(image['Id'] == expected_candidate_image_id, 'Existing candidate image ID mismatch')
    else:
        require(expected_candidate_image_id is None, 'Expected candidate image does not exist; rebuild refused')
        run(['docker', 'build', '--pull=false', '--network=none', '-f', str(stage / 'Dockerfile.lan'), '-t', tag, str(stage)], timeout=300)
        image = inspect('image', tag)
    base_image = inspect('image', BASE_ID)
    require(image['Config'] == base_image['Config'], 'Candidate runtime config differs from accepted base')
    layers = base_image['RootFS']['Layers']
    require(image['RootFS']['Layers'][:len(layers)] == layers, 'Candidate is not an overlay of accepted base')
    password = secrets.token_urlsafe(24)
    salt = secrets.token_hex(16)
    hashed = salt + ':' + hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1, dklen=64).hex()
    cid = None
    try:
        cid = run(['docker', 'create', '--name', name, '--network', 'none', '--user', '101:101', '--read-only', '--cap-drop=ALL', '--security-opt', 'no-new-privileges', '--memory', '512m', '--cpus', '1', '--pids-limit', '64', '-e', 'CAR_PASSWORD_HASH=' + hashed, '-e', 'CAR_PASSWORD_HASH_FILE=', '-e', 'CAR_ORIGIN=http://127.0.0.1:5173', '-e', 'CAR_SPECTATOR_ORIGIN=http://localhost:5173', image['Id']]).decode().strip()
        run(['docker', 'start', cid])
        candidate_files(cid, manifest)
        for attempt in range(30):
            try:
                probe(cid, assets, readiness=True)
                break
            except RuntimeError:
                if attempt == 29:
                    raise
                time.sleep(1)
        probe(cid, assets, password)
        probe(cid, assets, password, spectator=True)
    finally:
        if cid:
            require(inspect('container', cid)['Name'] == '/' + name, 'Candidate cleanup identity mismatch')
            run(['docker', 'rm', '-f', cid])
    preservation(release, digest, baseline, before, auth_metadata, config)
    require(config_metadata() == config_security and config_identities() == config_identity, 'Config metadata or inode changed during preparation')
    write_json(receipt_path, {'schema': 1, 'release': release, 'manifest_sha256': digest, 'identity': manifest['identity'], 'image_id': image['Id'], 'baseline_image_id': BASELINE_IMAGE_ID, 'baseline_release': BASELINE_RELEASE, 'baseline_tag': BASELINE_TAG, 'baseline_source_commit': BASELINE_SOURCE_COMMIT, 'baseline_container_id': baseline['Id'], 'baseline_snapshot': snapshot(baseline), 'neighbors': before, 'auth_metadata': auth_metadata, 'operator_sha256': sha(Path(__file__)), 'config_security': config_security, 'config_identity': config_identity, **config, **activated_config})
    print('Prepared ' + release + '; isolated authentication, assets and room probes passed. Live service unchanged.')


def auth_access(image_id):
    secret = ROOT / 'secrets/game-password-hash'
    require(not secret.is_symlink() and secret.is_file(), 'Authentication source changed type')
    run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--user', '101:101', '--cap-drop=ALL', '--security-opt', 'no-new-privileges', '--memory', '512m', '--cpus', '1', '--pids-limit', '64', '--mount', 'type=bind,src=' + str(secret) + ',dst=/run/secrets/game-password-hash,readonly', '--entrypoint', 'node', image_id, '-e', "require('node:fs').accessSync('/run/secrets/game-password-hash',require('node:fs').constants.R_OK)"])


def compose_up():
    run(COMPOSE + ['config', '--quiet'])
    run(COMPOSE + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '60', 'car-soccer'], timeout=100)


def restore(record):
    guard_root()
    safe(ROOT / 'receipts', True)
    restored_receipt = ROOT / 'receipts' / ('rolled-back-' + record['release'] + '.json')
    require(not restored_receipt.exists() and not restored_receipt.is_symlink(), 'Rollback for this release was already completed')
    backup = ROOT / 'rollback' / record['rollback_directory']
    require(re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-' + re.escape(record['release']), backup.name), 'Invalid rollback directory')
    safe(backup, True)
    for name, key in [('.env', 'env_sha256'), ('compose.yaml', 'compose_sha256')]:
        safe(backup / name)
        require(sha(backup / name) == record[key], 'Rollback backup hash mismatch')
        require(file_security(backup / name) == record['config_security'][name], 'Rollback backup security metadata changed')
    require(record['baseline_release'] == BASELINE_RELEASE and record['baseline_tag'] == BASELINE_TAG and record['baseline_image_id'] == BASELINE_IMAGE_ID and record['baseline_source_commit'] == BASELINE_SOURCE_COMMIT, 'Unexpected recorded deployment baseline')
    require(inspect('image', record['baseline_tag'])['Id'] == record['baseline_image_id'], 'Rollback image tag changed')
    require({k: record[k] for k in EXPECTED_CONFIG} == EXPECTED_CONFIG, 'Recorded baseline config differs from verified hashes')
    validate_restore_configs(record)
    require(neighbors() == record['neighbors'], 'Neighbor state changed; rollback refused before mutation')
    require(secret_metadata() == record['auth_metadata'], 'Authentication state changed; rollback refused before mutation')
    recovery_state(record)
    for name in ['.env', 'compose.yaml']:
        p = backup / name
        atomic_config(ROOT / name, p.read_bytes(), p)
    require(config_hashes() == {k: record[k] for k in ('env_sha256', 'compose_sha256')}, 'Restored configuration mismatch')
    require(config_metadata() == record['config_security'], 'Restored configuration security mismatch')
    compose_up()
    require(live()['Image'] == record['baseline_image_id'], 'Rollback image verification failed')
    require(neighbors() == record['neighbors'] and secret_metadata() == record['auth_metadata'], 'Neighbor or authentication state differs after rollback')
    write_json(restored_receipt, {'release': record['release'], 'baseline_image_id': record['baseline_image_id'], 'rollback_directory': record['rollback_directory'], 'env_sha256': record['env_sha256'], 'compose_sha256': record['compose_sha256']})


def activate(release, digest, receipt_path):
    _, _, assets = package(release, digest)
    safe(receipt_path)
    r = json.loads(receipt_path.read_bytes())
    require(r['operator_sha256'] == sha(Path(__file__)), 'Prepared operator changed')
    require(r['release'] == release and r['manifest_sha256'] == digest, 'Receipt identity mismatch')
    require(r['baseline_release'] == BASELINE_RELEASE and r['baseline_tag'] == BASELINE_TAG and r['baseline_image_id'] == BASELINE_IMAGE_ID and r['baseline_source_commit'] == BASELINE_SOURCE_COMMIT, 'Unexpected prepared deployment baseline')
    require(inspect('image', r['baseline_tag'])['Id'] == r['baseline_image_id'], 'Deployment baseline image tag changed')
    require({k: r[k] for k in EXPECTED_CONFIG} == EXPECTED_CONFIG, 'Prepared baseline config differs from verified hashes')
    require(config_hashes() == {k: r[k] for k in ['env_sha256', 'compose_sha256']}, 'Live configuration changed')
    require({k: list(v) for k, v in config_identities().items()} == r['config_identity'], 'Configuration inode changed')
    require(config_metadata() == r['config_security'], 'Configuration owner/mode/ACL changed')
    require(snapshot(live(r['baseline_container_id'])) == r['baseline_snapshot'], 'Live state changed')
    require(neighbors() == r['neighbors'], 'Neighbor state changed')
    require(secret_metadata() == r['auth_metadata'], 'Authentication file identity or ACL changed')
    require(inspect('image', 'car-soccer-private:' + release)['Id'] == r['image_id'], 'Prepared image changed')
    headroom()
    # Check access and metadata only; this process never reads production hash bytes.
    auth_access(r['baseline_image_id'])
    env = (ROOT / '.env').read_bytes()
    updated, updated_compose = config_delta(env, (ROOT / 'compose.yaml').read_bytes(), release)
    require(hashlib.sha256(updated).hexdigest() == r['activated_env_sha256'] and hashlib.sha256(updated_compose).hexdigest() == r['activated_compose_sha256'], 'Prepared activated configuration mismatch')
    backup_root = ROOT / 'rollback'
    if not backup_root.exists():
        backup_root.mkdir(mode=0o700)
    safe(backup_root, True)
    require(not list(backup_root.glob('*-' + release)), 'Activation for this release was already consumed')
    r['rollback_directory'] = time.strftime('%Y%m%dT%H%M%SZ-', time.gmtime()) + release
    backup = backup_root / r['rollback_directory']
    backup.mkdir(mode=0o700)  # Exclusive: a consumed activation is never replayed.
    for name in ['.env', 'compose.yaml']:
        shutil.copy2(ROOT / name, backup / name)
        source_stat = (ROOT / name).stat()
        os.chown(backup / name, source_stat.st_uid, source_stat.st_gid)
        # Check mode/owner/ACL on the copied original before consuming activation.
        original = ROOT / name
        copied = backup / name
        require(stat.S_IMODE(copied.stat().st_mode) == stat.S_IMODE(source_stat.st_mode), 'Backup mode mismatch')
        require({k: os.getxattr(copied, k) for k in os.listxattr(copied)} == {k: os.getxattr(original, k) for k in os.listxattr(original)}, 'Backup ACL/xattrs mismatch')
        require(sha(backup / name) == r['env_sha256' if name == '.env' else 'compose_sha256'], 'Backup mismatch')
    for name in ('.env', 'compose.yaml'):
        with (backup / name).open('rb') as stream: os.fsync(stream.fileno())
    write_json(backup / 'record.json', r)
    directory = os.open(backup_root, os.O_RDONLY | os.O_DIRECTORY)
    try: os.fsync(directory)
    finally: os.close(directory)
    require(config_hashes() == {k: r[k] for k in ('env_sha256', 'compose_sha256')} and config_metadata() == r['config_security'], 'Configuration changed during activation preflight')
    require({k: list(v) for k, v in config_identities().items()} == r['config_identity'], 'Configuration inode changed during activation preflight')
    try:
        atomic_config(ROOT / '.env', updated)
        atomic_config(ROOT / 'compose.yaml', updated_compose)
        require(config_hashes() == {'env_sha256': r['activated_env_sha256'], 'compose_sha256': r['activated_compose_sha256']}, 'Activated configuration hash mismatch')
        require(config_metadata() == r['config_security'], 'Activated configuration security mismatch')
        compose_up()
        c = live()
        require(c['Image'] == r['image_id'], 'Activated image mismatch')
        probe(c['Id'], assets)
        probe(c['Id'], assets, spectator=True)
        require(neighbors() == r['neighbors'] and secret_metadata() == r['auth_metadata'], 'Neighbor or authentication state changed')
    except Exception:
        restore(r)
        raise RuntimeError('Activation failed; baseline configuration and image restored (sessions reset)') from None
    write_json(ROOT / 'receipts' / ('activated-' + release + '.json'), {'release': release, 'image_id': r['image_id'], 'manifest_sha256': digest, 'container_id': c['Id'], 'rollback_record': str(backup / 'record.json')})
    print('Activated ' + release + '; health, release, gate and neighbor checks passed. Sessions reset.')


def main():
    global ROOT_IDENTITY, LOCK_IDENTITY, LOCK_FD
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('action', choices=['prepare', 'activate', 'rollback'])
    p.add_argument('release')
    p.add_argument('manifest_sha256')
    p.add_argument('--expected-operator-sha256', required=True, help='Independently frozen digest of this external operator')
    p.add_argument('--allow-session-reset', action='store_true')
    p.add_argument('--expected-candidate-image-id', help='Prepare only: reuse exactly this existing sha256 image without rebuilding')
    a = p.parse_args()
    require(re.fullmatch(r'[0-9a-f]{64}', a.expected_operator_sha256) and sha(Path(__file__)) == a.expected_operator_sha256, 'External operator digest mismatch')
    require(re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}', a.release) and a.release not in {'.', '..'}, 'Invalid release name')
    require(re.fullmatch(r'[0-9a-f]{64}', a.manifest_sha256), 'Invalid manifest digest')
    require(a.expected_candidate_image_id is None or (a.action == 'prepare' and re.fullmatch(r'sha256:[0-9a-f]{64}', a.expected_candidate_image_id)), 'Expected candidate image ID is valid only for prepare and must be a full sha256 ID')
    require(a.action == 'prepare' or a.allow_session_reset, 'Explicit --allow-session-reset required')
    safe(ROOT, True)
    require(ROOT.resolve() == ROOT, 'Root or ancestor symlink refused')
    root_identity = (ROOT.stat().st_dev, ROOT.stat().st_ino)
    os.chdir(ROOT)
    lockfd = os.open(ROOT / 'deployment.lock', os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lockfd, 'a') as lock:
        lock_identity = safe_lock(ROOT / 'deployment.lock', lock.fileno())
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        require(safe_lock(ROOT / 'deployment.lock', lock.fileno()) == lock_identity, 'Deployment lock changed while acquiring flock')
        require((ROOT.stat().st_dev, ROOT.stat().st_ino) == root_identity and ROOT.resolve() == ROOT, 'Deployment root changed')
        ROOT_IDENTITY, LOCK_IDENTITY, LOCK_FD = root_identity, lock_identity, lock.fileno()
        receipts = ROOT / 'receipts'
        if not receipts.exists():
            receipts.mkdir(mode=0o700)
        safe(receipts, True)
        receipt = receipts / ('prepared-' + a.release + '.json')
        if a.action == 'prepare':
            prepare(a.release, a.manifest_sha256, receipt, a.expected_candidate_image_id)
        elif a.action == 'activate':
            activate(a.release, a.manifest_sha256, receipt)
        else:
            safe(ROOT / 'rollback', True)
            records = list((ROOT / 'rollback').glob('*-' + a.release))
            require(len(records) == 1, 'Expected exactly one release rollback record')
            safe(records[0], True)
            record_path = records[0] / 'record.json'
            safe(record_path)
            r = json.loads(record_path.read_bytes())
            require(r['operator_sha256'] == a.expected_operator_sha256, 'Rollback operator changed')
            require(r['release'] == a.release and r['manifest_sha256'] == a.manifest_sha256, 'Rollback identity mismatch')
            restore(r)
            print('Baseline restored; sessions reset.')


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        # Do not surface subprocess output, config, credentials or environment values.
        print('Release operator stopped: ' + (str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__), file=sys.stderr)
        sys.exit(1)
