from contextlib import contextmanager
import hashlib
from io import BytesIO
import json
from pathlib import Path
import shlex
import subprocess
import sys
import os
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).parents[1] / 'scripts'))
from ha_config import load_config
from ha_bridge import HATransport
import ha_bridge_runner as runner


class Response(BytesIO):
    status = 200


@contextmanager
def fixture(mode='local', same=False):
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        staging = root / 'staging config'
        bridge = staging if same else root / "bridge ' config"
        identity = root / 'operator home/.ssh/synthetic ha key'
        identity.parent.mkdir(parents=True)
        identity.write_text('synthetic key fixture, never used for authentication')
        identity.chmod(0o600)
        digest = hashlib.sha256(b'synthetic card').hexdigest()
        card = 'apartment-hotel-card.' + digest[:12] + '.js'
        previous = '/local/apartment-hotel/apartment-hotel-card.000000000000.js'
        for path in {staging, bridge}:
            (path / 'www/apartment-hotel/models').mkdir(parents=True)
            (path / 'www/apartment-hotel/sprites').mkdir()
            (path / 'custom_components/apartment_hotel').mkdir(parents=True)
            (path / 'configuration.yaml').write_text('unrelated: keep\nresources:\n  - url: ' + previous + '\n')
            (path / 'www/apartment-hotel/old-card.js').write_text('keep old artifact')
            (path / 'www/apartment-hotel/models/model.glb').write_bytes(b'synthetic model')
            (path / 'www/apartment-hotel/sprites/sprite.png').write_bytes(b'synthetic sprite')
            (path / 'custom_components/apartment_hotel/public_snapshot.py').write_text('old publisher')
        (staging / 'www/apartment-hotel' / card).write_bytes(b'synthetic card')
        publisher = root / 'public_snapshot.py'
        publisher.write_text('synthetic publisher')
        release = {'card': card, 'url': '/local/apartment-hotel/' + card, 'previousUrl': previous, 'sha256': digest}
        env = {'HOME_ASSISTANT_CHECKOUT': str(staging), 'HOME_ASSISTANT_BRIDGE_MODE': mode,
               'HOME_ASSISTANT_BRIDGE': 'synthetic-bridge', 'HOME_ASSISTANT_BRIDGE_CHECKOUT': str(bridge),
               'HOME_ASSISTANT_SSH_TARGET': 'root@ha.synthetic.invalid',
               'HOME_ASSISTANT_SSH_IDENTITY': '~/.ssh/synthetic ha key',
               'HOME_ASSISTANT_URL': 'http://ha.synthetic.invalid:8123'}
        yield root, staging, bridge, identity, publisher, release, env


def request(config, operation, **extra):
    return {'operation': operation, 'bridge_checkout': config.bridge_checkout,
            'ssh_identity': config.ssh_identity, 'ssh_target': config.ssh_target,
            'ha_url': config.ha_url, **extra}


class HABridgeTests(unittest.TestCase):
    def test_explicit_modes_preserve_remote_default_without_requiring_local_alias(self):
        with fixture() as (_, _, _, _, _, _, env):
            local = dict(env)
            del local['HOME_ASSISTANT_BRIDGE']
            self.assertIsNone(load_config(local).bridge)
            del local['HOME_ASSISTANT_BRIDGE_MODE']
            with self.assertRaises(RuntimeError): load_config(local)
            self.assertEqual(load_config({**env, 'HOME_ASSISTANT_BRIDGE_MODE': 'ssh'}).bridge_mode, 'ssh')
            for value in ['auto', '', 'SSH']:
                with self.assertRaises(RuntimeError): load_config({**env, 'HOME_ASSISTANT_BRIDGE_MODE': value})
            for value in ['user@ha.invalid', '-oProxyCommand=anything']:
                with self.assertRaises(RuntimeError): load_config({**env, 'HOME_ASSISTANT_SSH_TARGET': value})

    def test_local_preflight_expands_identity_on_bridge_and_keeps_exact_ha_guard(self):
        with fixture() as (root, _, _, identity, _, _, env), patch.dict('os.environ', {'HOME': str(root / 'operator home')}), patch.object(runner.subprocess, 'run') as run, patch.object(runner, 'urlopen', return_value=Response()):
            result = HATransport(load_config(env)).preflight()
            self.assertEqual(result['identity'], str(identity.resolve()))
            args = run.call_args.args[0]
            self.assertEqual(args[0], 'ssh')
            for option in ['IdentitiesOnly=yes', 'StrictHostKeyChecking=yes', 'UpdateHostKeys=no', str(identity.resolve())]: self.assertIn(option, args)
            self.assertNotIn("'~/.ssh/synthetic ha key'", args)
            self.assertEqual(args[-2], 'root@ha.synthetic.invalid')
            self.assertIn('test "$(id -un)" = root', run.call_args.kwargs['input'])

    def test_preflight_accepts_ha_auth_boundary_but_rejects_network_or_identity_failure(self):
        with fixture() as (root, _, _, identity, _, _, env), patch.dict('os.environ', {'HOME': str(root / 'operator home')}):
            error = HTTPError('http://ha.synthetic.invalid/api/', 401, 'unauthorized', {}, None)
            with patch.object(runner.subprocess, 'run'), patch.object(runner, 'urlopen', side_effect=error): HATransport(load_config(env)).preflight()
            with patch.object(runner.subprocess, 'run', side_effect=subprocess.CalledProcessError(255, ['ssh'])), patch.object(runner, 'urlopen') as http:
                with self.assertRaises(subprocess.CalledProcessError): HATransport(load_config(env)).preflight()
                http.assert_not_called()
            identity.chmod(0o644)
            with patch.object(runner.subprocess, 'run') as run:
                with self.assertRaises(RuntimeError): HATransport(load_config(env)).preflight()
                run.assert_not_called()

    def test_same_checkout_never_copies_to_itself_or_changes_unrelated_configuration(self):
        with fixture(same=True) as (_, staging, bridge, _, _, release, env), patch('ha_bridge.shutil.copy2') as copy, patch('ha_bridge.shutil.copytree') as tree:
            transport = HATransport(load_config(env)); transport.ready = {'checkout': str(bridge)}
            before = (bridge / 'configuration.yaml').read_text()
            transport.stage(staging / 'www/apartment-hotel' / release['card'], 'www/apartment-hotel/' + release['card'])
            transport.stage(staging / 'www/apartment-hotel/models', 'www/apartment-hotel/models', directory=True)
            copy.assert_not_called(); tree.assert_not_called()
            self.assertEqual((bridge / 'configuration.yaml').read_text(), before)

    def test_distinct_local_staging_keeps_old_assets_and_configuration(self):
        with fixture() as (_, staging, bridge, _, _, release, env):
            transport = HATransport(load_config(env)); transport.ready = {'checkout': str(bridge)}
            before = (bridge / 'configuration.yaml').read_text()
            transport.stage(staging / 'www/apartment-hotel' / release['card'], 'www/apartment-hotel/' + release['card'])
            transport.stage(staging / 'www/apartment-hotel/models', 'www/apartment-hotel/models', directory=True)
            self.assertEqual((bridge / 'www/apartment-hotel' / release['card']).read_bytes(), b'synthetic card')
            self.assertEqual((bridge / 'www/apartment-hotel/old-card.js').read_text(), 'keep old artifact')
            self.assertEqual((bridge / 'configuration.yaml').read_text(), before)
            for bad in ['configuration.yaml', '../../configuration.yaml']:
                with self.assertRaises(RuntimeError): transport.stage(staging / 'configuration.yaml', bad)

    def test_remote_mode_sends_json_to_fixed_runner_and_expands_home_on_remote_bridge(self):
        with fixture(mode='ssh') as (_, staging, bridge, _, _, release, env):
            config = load_config(env); transport = HATransport(config)
            with patch('ha_bridge.subprocess.check_output', return_value=json.dumps({'checkout': str(bridge), 'identity': '/remote/home/.ssh/synthetic', 'resource': release['previousUrl']})) as run:
                transport.preflight(); args = run.call_args.args[0]
                self.assertEqual(args[-2], 'synthetic-bridge')
                self.assertEqual(shlex.split(args[-1])[:2], ['python3', '-c'])
                self.assertEqual(json.loads(run.call_args.kwargs['input'])['ssh_identity'], '~/.ssh/synthetic ha key')
                self.assertNotIn(config.bridge_checkout, args[-1])
            with patch('ha_bridge.subprocess.run') as copy:
                transport.stage(staging / 'www/apartment-hotel' / release['card'], 'www/apartment-hotel/' + release['card'])
                self.assertEqual(copy.call_args.args[0][-1], 'synthetic-bridge:' + str(bridge / 'www/apartment-hotel' / release['card']))
                self.assertNotIn('shell', copy.call_args.kwargs)

    def test_deploy_checks_hashes_and_preserves_backup_config_check_restart_order(self):
        with fixture(same=True) as (root, staging, bridge, _, publisher, release, env), patch.dict('os.environ', {'HOME': str(root / 'operator home')}):
            (staging / 'configuration.yaml').write_text('unrelated: keep\nurl: ' + release['url'] + '\n')
            transport = HATransport(load_config(env))
            with patch.object(runner.subprocess, 'run') as run, patch.object(runner.subprocess, 'check_output', return_value=hashlib.sha256(publisher.read_bytes()).hexdigest() + '  publisher\n'), patch.object(runner, 'urlopen', return_value=Response()): expected = transport.deploy(release, publisher)
            self.assertIn(release['card'], expected)
            self.assertEqual((staging / 'custom_components/apartment_hotel/public_snapshot.py').read_text(), 'synthetic publisher')
            text = (bridge / 'configuration.yaml').read_text()
            self.assertIn('unrelated: keep', text); self.assertIn(release['url'], text)
            script = run.call_args.kwargs['input']
            self.assertLess(script.index('before-apartment-furniture'), script.index('ha core check'))
            self.assertLess(script.index('ha core check'), script.index('ha core restart'))
            self.assertIn(release['previousUrl'], script)
            expected[release['card']] = '0' * 64
            with patch.object(runner.subprocess, 'run') as run:
                with self.assertRaises(RuntimeError): runner.handle(request(transport.config, 'deploy', release=release, expected=expected, publisher_sha256='0' * 64))
                run.assert_not_called()

    def test_changed_private_resource_blocks_before_any_ha_mutation(self):
        with fixture() as (root, _, bridge, _, _, release, env), patch.dict('os.environ', {'HOME': str(root / 'operator home')}):
            (bridge / 'configuration.yaml').write_text('url: /local/apartment-hotel/apartment-hotel-card.111111111111.js\n')
            with patch.object(runner.subprocess, 'run') as run:
                with self.assertRaises(RuntimeError): runner.handle(request(load_config(env), 'deploy', release=release, expected={release['card']: release['sha256']}, publisher_sha256='0' * 64))
                run.assert_not_called()

    def test_different_staging_resource_is_rejected_before_copying(self):
        with fixture() as (root, _, bridge, _, _, _, env), patch.dict('os.environ', {'HOME': str(root / 'operator home')}), patch.object(runner.subprocess, 'run'), patch.object(runner, 'urlopen', return_value=Response()):
            (bridge / 'configuration.yaml').write_text('url: /local/apartment-hotel/apartment-hotel-card.111111111111.js\n')
            with self.assertRaises(RuntimeError):
                HATransport(load_config(env)).preflight()

    def test_fixed_remote_program_keeps_child_output_out_of_its_json_protocol(self):
        with fixture() as (root, _, bridge, _, publisher, release, env):
            static = bridge / 'www/apartment-hotel'
            (static / release['card']).write_bytes(b'synthetic card')
            (bridge / 'custom_components/apartment_hotel/public_snapshot.py').write_bytes(publisher.read_bytes())
            bin_path = root / 'bin'
            bin_path.mkdir()
            publisher_sha = hashlib.sha256(publisher.read_bytes()).hexdigest()
            for command in ['ssh', 'scp']:
                fake = bin_path / command
                fake.write_text('#!' + sys.executable + '\nimport sys\nprint(' + repr(publisher_sha + ' publisher') + ' if "sha256sum" in sys.argv[-1] else "synthetic child status output")\n')
                fake.chmod(0o700)
            payload = request(load_config(env), 'deploy', release=release, expected={release['card']: release['sha256']}, publisher_sha256=publisher_sha)
            result = subprocess.run([sys.executable, '-c', Path(runner.__file__).read_text()], input=json.dumps(payload), text=True, capture_output=True, env={**os.environ, 'HOME': str(root / 'operator home'), 'PATH': str(bin_path) + ':' + os.environ['PATH']}, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), {'deployed': release['url']})
            self.assertNotIn('synthetic child status', result.stdout)

    def test_served_hash_verification_is_read_only_and_rejects_wrong_bytes(self):
        with fixture() as (root, _, _, _, _, release, env), patch.dict('os.environ', {'HOME': str(root / 'operator home')}):
            expected = {release['card']: release['sha256']}
            with patch.object(runner, 'urlopen', return_value=Response(b'synthetic card')), patch.object(runner.subprocess, 'run') as write:
                self.assertEqual(runner.handle(request(load_config(env), 'verify', release=release, expected=expected)), {'verified': 1}); write.assert_not_called()
            with patch.object(runner, 'urlopen', return_value=Response(b'wrong artifact')):
                with self.assertRaises(RuntimeError): runner.handle(request(load_config(env), 'verify', release=release, expected=expected))


if __name__ == '__main__': unittest.main()
