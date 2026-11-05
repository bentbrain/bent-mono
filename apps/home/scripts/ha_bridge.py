"""Local or SSH bridge transport; the final HA hop always uses its existing key."""
import hashlib
import json
import re
from pathlib import Path, PurePosixPath
import shlex
import shutil
import subprocess
from ha_bridge_runner import handle, resource_url, validate_files, validate_release


class HATransport:
    def __init__(self, config):
        self.config = config
        self.ready = None

    def invoke(self, operation, **payload):
        request = {
            'operation': operation, 'bridge_checkout': self.config.bridge_checkout,
            'ssh_identity': self.config.ssh_identity, 'ssh_target': self.config.ssh_target,
            'ha_url': self.config.ha_url, **payload,
        }
        if self.config.bridge_mode == 'local':
            return handle(request)
        runner = Path(__file__).with_name('ha_bridge_runner.py').read_text()
        command = shlex.join(['python3', '-c', runner])
        output = subprocess.check_output(
            ['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no', '--', self.config.bridge, command],
            input=json.dumps(request), text=True, timeout=(90 if operation == 'preflight' else max(900, 30 + 12 * len(payload.get('expected', {})))),
        )
        result = json.loads(output)
        if not isinstance(result, dict):
            raise RuntimeError('Invalid HA bridge response')
        return result

    def preflight(self, release=None):
        self.ready = self.invoke('preflight')
        if not isinstance(self.ready.get('checkout'), str) or not Path(self.ready['checkout']).is_absolute():
            raise RuntimeError('Bridge must return its absolute existing checkout')
        staging = resource_url((self.config.checkout / 'configuration.yaml').read_text())
        if release is None:
            if self.ready.get('resource') != staging:
                raise RuntimeError('Staging and bridge resources differ; preserve the existing private release')
        else:
            validate_release(release)
            if staging != release['url'] or self.ready.get('resource') not in [release['previousUrl'], release['url']]:
                raise RuntimeError('Prepared private release does not match the staging and bridge resources')
        return self.ready

    def stage(self, source, relative, *, directory=False):
        if self.ready is None:
            raise RuntimeError('HA preflight is required before staging')
        relative_path = PurePosixPath(relative)
        if relative_path.is_absolute() or '..' in relative_path.parts:
            raise RuntimeError('Invalid private staging destination')
        if directory:
            allowed = relative in ['www/apartment-hotel/models', 'www/apartment-hotel/sprites']
        else:
            allowed = relative == 'custom_components/apartment_hotel/public_snapshot.py' or (
                relative.startswith('www/apartment-hotel/') and
                re.fullmatch(r'apartment-hotel-card\.[a-f0-9]{12}\.js', relative_path.name)
            )
        if not allowed:
            raise RuntimeError('Staging destination is outside the approved release files')
        source = Path(source).resolve()
        destination = Path(self.ready['checkout']) / relative
        if self.config.bridge_mode == 'local':
            if source == destination.resolve() or (destination.exists() and source.samefile(destination)):
                return
            if directory:
                shutil.copytree(source, destination, dirs_exist_ok=True)
            else:
                shutil.copy2(source, destination)
        else:
            # OpenSSH's existing SFTP scp transport preserves each argv path,
            # including spaces. Do not add shell quotes to the remote filename.
            args = ['scp', '-B', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no']
            if directory:
                args.append('-r')
                destination = destination.parent
            subprocess.run([*args, '--', str(source), f'{self.config.bridge}:{destination}'], check=True, timeout=300)

    def deploy(self, release, publisher):
        validate_release(release)
        self.preflight(release)
        static = self.config.checkout / 'www/apartment-hotel'
        files = [static / release['card']]
        for folder in ['models', 'sprites']:
            files.extend(path for path in sorted((static / folder).rglob('*')) if path.is_file())
        expected = {path.relative_to(static).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest() for path in files}
        validate_files(expected, release)
        self.stage(static / release['card'], 'www/apartment-hotel/' + release['card'])
        for folder in ['models', 'sprites']:
            self.stage(static / folder, 'www/apartment-hotel/' + folder, directory=True)
        staged_publisher = self.config.checkout / 'custom_components/apartment_hotel/public_snapshot.py'
        if Path(publisher).resolve() != staged_publisher.resolve() and not (
            staged_publisher.exists() and Path(publisher).samefile(staged_publisher)
        ):
            shutil.copy2(publisher, staged_publisher)
        self.stage(staged_publisher, 'custom_components/apartment_hotel/public_snapshot.py')
        self.invoke('deploy', release=release, expected=expected, publisher_sha256=hashlib.sha256(Path(publisher).read_bytes()).hexdigest())
        return expected
