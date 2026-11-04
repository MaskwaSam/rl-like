"""Bounded local tests; fake Docker calls, synthetic configuration, no credentials/network."""
import importlib.util
from pathlib import Path
import hashlib
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('release_operator', Path(__file__).with_name('release_operator.py'))
op = importlib.util.module_from_spec(spec)
spec.loader.exec_module(op)
REAL_RECOVERY = op.recovery_state
RELEASE = '20261104-spectator-0123456789ab'
ENV = ('UNCHANGED=1\nCAR_RELEASE=' + op.BASELINE_RELEASE + '\nTAIL=yes\n').encode()
COMPOSE = b'services:\n  car-soccer:\n    environment:\n      CAR_ORIGIN: https://car.spatterson.ca\n      OTHER: unchanged\n'

def digest(data):
    return hashlib.sha256(data).hexdigest()

class ReleaseTests(unittest.TestCase):
    def setUp(self):
        # This macOS Python lacks Linux xattrs. Model them explicitly in tests;
        # production operator still requires Linux xattr support and fails closed.
        recovery = patch.object(op, 'recovery_state', return_value=None)
        recovery.start(); self.addCleanup(recovery.stop)
        self.attrs = {}
        def listing(path): return list(self.attrs.get(str(path), {}))
        def getting(path, key): return self.attrs[str(path)][key]
        def setting(path, key, value): self.attrs.setdefault(str(path), {})[key] = value
        for name, fn in [('listxattr', listing), ('getxattr', getting), ('setxattr', setting)]:
            patcher = patch.object(op.os, name, side_effect=fn, create=True)
            patcher.start(); self.addCleanup(patcher.stop)

    def test_direct_command_startup(self):
        import subprocess, sys
        result = subprocess.run([sys.executable, '-I', str(Path(op.__file__)), '--help'], capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertIn(b'--expected-operator-sha256', result.stdout)

    def test_exact_delta(self):
        env, compose = op.config_delta(ENV, COMPOSE, RELEASE)
        self.assertEqual(env, ENV.replace(op.BASELINE_RELEASE.encode(), RELEASE.encode()))
        self.assertEqual(compose, COMPOSE.replace(b'      CAR_ORIGIN: https://car.spatterson.ca\n', b'      CAR_ORIGIN: https://car.spatterson.ca\n' + op.SPECTATOR_LINE))
        self.assertEqual(compose.replace(op.SPECTATOR_LINE, b''), COMPOSE)

    def test_ambiguous_configs_rejected(self):
        for env in [ENV + b'CAR_RELEASE=other\n', ENV.replace(op.BASELINE_RELEASE.encode(), b'unknown'), b'OTHER=1\n']:
            with self.subTest(env=env), self.assertRaises(RuntimeError):
                op.config_delta(env, COMPOSE, RELEASE)
        for compose in [COMPOSE + op.SPECTATOR_LINE, COMPOSE + b'      CAR_ORIGIN: duplicate\n', COMPOSE.replace(b'CAR_ORIGIN:', b'OTHER_ORIGIN:'), COMPOSE.replace(b'\n', b'\r\n')]:
            with self.subTest(compose=compose), self.assertRaises(RuntimeError):
                op.config_delta(ENV, compose, RELEASE)

    def fixture(self, root):
        new_env, new_compose = op.config_delta(ENV, COMPOSE, RELEASE)
        (root / 'receipts').mkdir(exist_ok=True)
        for name, data in [('.env', ENV), ('compose.yaml', COMPOSE)]:
            (root / name).write_bytes(data)
            (root / name).chmod(0o640)
        backup_name = '20261104T120000Z-' + RELEASE
        backup = root / 'rollback' / backup_name
        backup.mkdir(parents=True, mode=0o700)
        for name, data in [('.env', ENV), ('compose.yaml', COMPOSE)]:
            (backup / name).write_bytes(data)
            (backup / name).chmod(0o640)
        record = {'release': RELEASE, 'rollback_directory': backup_name, 'image_id': 'candidate',
                  'env_sha256': digest(ENV), 'compose_sha256': digest(COMPOSE),
                  'activated_env_sha256': digest(new_env), 'activated_compose_sha256': digest(new_compose),
                  'baseline_release': op.BASELINE_RELEASE, 'baseline_tag': op.BASELINE_TAG,
                  'baseline_image_id': op.BASELINE_IMAGE_ID, 'baseline_source_commit': op.BASELINE_SOURCE_COMMIT,
                  'neighbors': {'neighbor': 'unchanged'}, 'auth_metadata': {'inode': 42},
                  'config_security': op.config_metadata()}
        return record, new_env, new_compose

    def test_restore_all_partial_pairs(self):
        for env_new, compose_new in [(False, False), (True, False), (False, True), (True, True)]:
            with self.subTest(env_new=env_new, compose_new=compose_new), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                with patch.object(op, 'ROOT', root):
                    record, new_env, new_compose = self.fixture(root)
                    (root / '.env').write_bytes(new_env if env_new else ENV)
                    (root / 'compose.yaml').write_bytes(new_compose if compose_new else COMPOSE)
                    calls = []
                    def fake_compose():
                        # Both originals must be restored before the first recreate.
                        self.assertEqual((root / '.env').read_bytes(), ENV)
                        self.assertEqual((root / 'compose.yaml').read_bytes(), COMPOSE)
                        calls.append('compose')
                    with patch.object(op, 'inspect', return_value={'Id': op.BASELINE_IMAGE_ID}), patch.object(op, 'compose_up', side_effect=fake_compose), patch.object(op, 'live', return_value={'Image': op.BASELINE_IMAGE_ID}), patch.object(op, 'neighbors', return_value=record['neighbors']), patch.object(op, 'secret_metadata', return_value=record['auth_metadata']), patch.object(op, 'EXPECTED_CONFIG', {k: record[k] for k in ('env_sha256','compose_sha256')}):
                        op.restore(record)
                        with self.assertRaisesRegex(RuntimeError, 'already completed'):
                            op.restore(record)
                    self.assertEqual(calls, ['compose'])
                    self.assertEqual(op.config_metadata(), record['config_security'])

    def test_unknown_config_refuses_before_either_write(self):
        for name in ('.env', 'compose.yaml'):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                with patch.object(op, 'ROOT', root):
                    record, new_env, new_compose = self.fixture(root)
                    (root / '.env').write_bytes(new_env)
                    (root / 'compose.yaml').write_bytes(new_compose)
                    (root / name).write_bytes(b'unrelated edit\n')
                    before = {n: (root / n).read_bytes() for n in ('.env','compose.yaml')}
                    with patch.object(op, 'inspect', return_value={'Id': op.BASELINE_IMAGE_ID}), patch.object(op, 'atomic_config') as write, patch.object(op, 'compose_up') as recreate, patch.object(op, 'EXPECTED_CONFIG', {k: record[k] for k in ('env_sha256','compose_sha256')}):
                        with self.assertRaisesRegex(RuntimeError, 'Unknown current'):
                            op.restore(record)
                        write.assert_not_called(); recreate.assert_not_called()
                    self.assertEqual(before, {n: (root / n).read_bytes() for n in before})

    def test_rollback_backup_tamper_rejected(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(op, 'ROOT', Path(tmp)):
            record, _, _ = self.fixture(Path(tmp))
            (Path(tmp) / 'rollback' / record['rollback_directory'] / 'compose.yaml').write_bytes(b'tamper')
            with patch.object(op, 'atomic_config') as write, self.assertRaisesRegex(RuntimeError, 'backup hash'):
                op.restore(record)
            write.assert_not_called()

    def test_compose_command_is_bounded_and_validates_first(self):
        with patch.object(op, 'run') as run:
            op.compose_up()
            self.assertEqual(run.call_args_list[0].args[0], op.COMPOSE + ['config','--quiet'])
            self.assertEqual(run.call_args_list[1].args[0], op.COMPOSE + ['up','-d','--no-deps','--no-build','--pull','never','--wait','--wait-timeout','60','car-soccer'])
        with patch.object(op, 'run', side_effect=RuntimeError('invalid compose')) as run:
            with self.assertRaises(RuntimeError): op.compose_up()
            self.assertEqual(run.call_count, 1)

    def test_activation_failure_after_each_config_write_restores_both(self):
        import json
        import shutil
        from contextlib import ExitStack
        for failure_after in (1, 2):
            with self.subTest(failure_after=failure_after), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                with patch.object(op, 'ROOT', root), ExitStack() as stack:
                    record, _, _ = self.fixture(root)
                    shutil.rmtree(root / 'rollback')
                    (root / 'receipts').mkdir(exist_ok=True)
                    record.update({'operator_sha256': op.sha(Path(op.__file__)), 'manifest_sha256': 'a' * 64,
                                   'image_id': 'candidate', 'baseline_container_id': 'baseline-container',
                                   'baseline_snapshot': {},
                                   'config_identity': {k: list(v) for k, v in op.config_identities().items()}})
                    record.pop('rollback_directory')
                    receipt = root / 'receipts' / 'prepared.json'
                    op.write_json(receipt, record)
                    for name, kwargs in [
                        ('package', {'return_value': (None, None, [])}),
                        ('inspect', {'side_effect': lambda kind, tag: {'Id': 'candidate' if tag.endswith(RELEASE) else op.BASELINE_IMAGE_ID}}),
                        ('live', {'return_value': {'Image': op.BASELINE_IMAGE_ID}}),
                        ('snapshot', {'return_value': {}}),
                        ('neighbors', {'return_value': record['neighbors']}),
                        ('secret_metadata', {'return_value': record['auth_metadata']}),
                        ('headroom', {}), ('auth_access', {}), ('probe', {}), ('compose_up', {})]:
                        stack.enter_context(patch.object(op, name, **kwargs))
                    stack.enter_context(patch.object(op, 'EXPECTED_CONFIG', {k: record[k] for k in ('env_sha256','compose_sha256')}))
                    real_write = op.atomic_config
                    writes = []
                    def injected_write(path, data, metadata_source=None):
                        records = list((root / 'rollback').glob('*/record.json'))
                        self.assertEqual(len(records), 1)
                        frozen = json.loads(records[0].read_bytes())
                        for key in ('env_sha256','compose_sha256','activated_env_sha256','activated_compose_sha256'):
                            self.assertEqual(frozen[key], record[key])
                        for name in ('.env','compose.yaml'):
                            self.assertTrue((records[0].parent / name).is_file())
                        real_write(path, data, metadata_source)
                        writes.append(path.name)
                        if len(writes) == failure_after:
                            raise RuntimeError('injected interruption after config replace')
                    stack.enter_context(patch.object(op, 'atomic_config', side_effect=injected_write))
                    with self.assertRaisesRegex(RuntimeError, 'baseline configuration and image restored'):
                        op.activate(RELEASE, 'a' * 64, receipt)
                    self.assertEqual((root / '.env').read_bytes(), ENV)
                    self.assertEqual((root / 'compose.yaml').read_bytes(), COMPOSE)
                    self.assertEqual(writes[-2:], ['.env', 'compose.yaml'])
                    self.assertEqual(len(list((root / 'rollback').glob('*-' + RELEASE))), 1)

    def test_rollback_drift_refuses_before_any_mutation(self):
        for drift in ('neighbors', 'auth'):
            with self.subTest(drift=drift), tempfile.TemporaryDirectory() as tmp, patch.object(op, 'ROOT', Path(tmp)):
                root = Path(tmp)
                record, new_env, new_compose = self.fixture(root)
                (root / '.env').write_bytes(new_env)
                (root / 'compose.yaml').write_bytes(new_compose)
                with patch.object(op, 'inspect', return_value={'Id': op.BASELINE_IMAGE_ID}), patch.object(op, 'EXPECTED_CONFIG', {k: record[k] for k in ('env_sha256','compose_sha256')}), patch.object(op, 'neighbors', return_value={} if drift == 'neighbors' else record['neighbors']), patch.object(op, 'secret_metadata', return_value={} if drift == 'auth' else record['auth_metadata']), patch.object(op, 'atomic_config') as write, patch.object(op, 'compose_up') as recreate:
                    with self.assertRaisesRegex(RuntimeError, 'before mutation'):
                        op.restore(record)
                    write.assert_not_called(); recreate.assert_not_called()
                self.assertEqual((root / '.env').read_bytes(), new_env)
                self.assertEqual((root / 'compose.yaml').read_bytes(), new_compose)

    def test_restore_recovers_stopped_or_absent_container(self):
        for present in (False, True):
            with self.subTest(present=present), tempfile.TemporaryDirectory() as tmp, patch.object(op, 'ROOT', Path(tmp)):
                root = Path(tmp)
                record, new_env, new_compose = self.fixture(root)
                (root / '.env').write_bytes(new_env)
                (root / 'compose.yaml').write_bytes(new_compose)
                def fake_live(expected_id=None, require_running=True):
                    return {'Id': 'stopped-id', 'Image': record['baseline_image_id'] if require_running else record['image_id']}
                with patch.object(op, 'recovery_state', REAL_RECOVERY), patch.object(op, 'run', return_value=b'stopped-id\n' if present else b''), patch.object(op, 'live', side_effect=fake_live) as live, patch.object(op, 'inspect', return_value={'Id': op.BASELINE_IMAGE_ID}), patch.object(op, 'neighbors', return_value=record['neighbors']), patch.object(op, 'secret_metadata', return_value=record['auth_metadata']), patch.object(op, 'EXPECTED_CONFIG', {k: record[k] for k in ('env_sha256','compose_sha256')}), patch.object(op, 'compose_up') as recreate:
                    op.restore(record)
                    recreate.assert_called_once()
                    if present:
                        self.assertEqual(live.call_args_list[0].kwargs, {'require_running': False})
                self.assertEqual((root / '.env').read_bytes(), ENV)
                self.assertEqual((root / 'compose.yaml').read_bytes(), COMPOSE)

    def test_recovery_refuses_unknown_image_or_docker_failure(self):
        record = {'image_id': 'candidate', 'baseline_image_id': 'baseline'}
        with patch.object(op, 'run', return_value=b'foreign-id\n'), patch.object(op, 'live', return_value={'Id': 'foreign-id', 'Image': 'foreign'}):
            with self.assertRaisesRegex(RuntimeError, 'Live image changed'):
                REAL_RECOVERY(record)
        with patch.object(op, 'run', side_effect=RuntimeError('Docker unavailable')):
            with self.assertRaisesRegex(RuntimeError, 'Docker unavailable'):
                REAL_RECOVERY(record)

    def test_symlink_and_hardlink_config_rejected(self):
        import os
        with tempfile.TemporaryDirectory() as tmp, patch.object(op, 'ROOT', Path(tmp)):
            root = Path(tmp)
            (root / 'source').write_bytes(ENV)
            (root / '.env').symlink_to(root / 'source')
            with self.assertRaises(RuntimeError): op.config_hashes()
            (root / '.env').unlink()
            os.link(root / 'source', root / '.env')
            with self.assertRaises(RuntimeError): op.config_hashes()

if __name__ == '__main__':
    unittest.main()
