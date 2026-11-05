"""Fixed bridge operations. SSH mode streams this program, never credentials."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shlex
import subprocess
import sys
from urllib.error import HTTPError
from urllib.parse import quote, urlsplit
from urllib.request import Request, urlopen

RESOURCE = r'/local/apartment-hotel/apartment-hotel-card(?:\.[a-f0-9]{12})?\.js(?:\?[^\s]+)?'
SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no', '-o', 'ConnectTimeout=10', '-o', 'ConnectionAttempts=1']


def resource_url(text):
    found = re.findall(RESOURCE, text)
    if len(found) != 1:
        raise RuntimeError('Expected exactly one existing apartment card resource')
    return found[0]


def context(request):
    checkout = Path(request['bridge_checkout']).expanduser().resolve()
    identity = Path(request['ssh_identity']).expanduser().resolve()
    target = request['ssh_target']
    if not re.fullmatch(r'root@[\w.:\[\]-]+', target):
        raise RuntimeError('Invalid HA SSH account')
    if not checkout.is_dir() or not (checkout / 'configuration.yaml').is_file():
        raise RuntimeError('Existing bridge checkout is required')
    if not identity.is_file() or identity.stat().st_mode & 0o077:
        raise RuntimeError('Existing private HA identity with owner-only permissions is required')
    for name in ['www/apartment-hotel', 'custom_components/apartment_hotel']:
        if not (checkout / name).is_dir():
            raise RuntimeError('Existing Apartment Hotel bridge directories are required')
    resource_url((checkout / 'configuration.yaml').read_text())
    url = urlsplit(request['ha_url'])
    if url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise RuntimeError('Invalid HA HTTP route')
    return checkout, identity, target


def ssh(identity, target, command, *, input=None, capture=False):
    args = ['ssh', *SSH_OPTIONS, '-i', str(identity), '--', target, shlex.join(command)]
    if capture:
        return subprocess.check_output(args, input=input, text=True, timeout=30)
    subprocess.run(args, input=input, text=True, check=True, timeout=180, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def validate_release(release):
    if not isinstance(release, dict) or not re.fullmatch(r'apartment-hotel-card\.[a-f0-9]{12}\.js', release.get('card', '')):
        raise RuntimeError('Expected a content-addressed card release')
    if release.get('url') != '/local/apartment-hotel/' + release['card'] or not re.fullmatch(r'[a-f0-9]{64}', release.get('sha256', '')):
        raise RuntimeError('Invalid private release identity')
    if not re.fullmatch(RESOURCE, release.get('previousUrl', '')):
        raise RuntimeError('Previous private resource URL is required for rollback')


def validate_files(expected, release):
    if not isinstance(expected, dict) or release['card'] not in expected:
        raise RuntimeError('Expected source asset hashes')
    for name, digest in expected.items():
        path = PurePosixPath(name)
        if path.is_absolute() or '..' in path.parts or str(path) != name:
            raise RuntimeError('Invalid asset path')
        if name != release['card'] and not name.startswith(('models/', 'sprites/')):
            raise RuntimeError('Asset is outside the approved static folders')
        if not isinstance(digest, str) or not re.fullmatch(r'[a-f0-9]{64}', digest):
            raise RuntimeError('Invalid source asset hash')
    if expected[release['card']] != release['sha256']:
        raise RuntimeError('Card hash does not match the release manifest')


def handle(request):
    checkout, identity, target = context(request)
    operation = request['operation']
    if operation == 'preflight':
        ssh(identity, target, ['sh', '-s'], input='set -e\ntest "$(id -un)" = root\ntest -r /config/configuration.yaml\ntest -d /config/www/apartment-hotel\ncommand -v ha >/dev/null\n')
        try:
            with urlopen(Request(request['ha_url'] + '/api/', method='GET'), timeout=10) as response:
                if response.status != 200:
                    raise RuntimeError('HA HTTP route is not ready')
        except HTTPError as error:
            if error.code != 401:
                raise RuntimeError('HA HTTP route is not ready') from error
            error.close()
        return {'checkout': str(checkout), 'identity': str(identity), 'resource': resource_url((checkout / 'configuration.yaml').read_text())}
    release = request['release']
    validate_release(release)
    expected = request['expected']
    validate_files(expected, release)
    if operation == 'verify':
        for path, want in expected.items():
            with urlopen(request['ha_url'] + '/local/apartment-hotel/' + quote(path, safe='/'), timeout=10) as response:
                got = hashlib.sha256(response.read()).hexdigest()
            if got != want:
                raise RuntimeError('Served asset hash does not match the prepared release')
        return {'verified': len(expected)}
    if operation != 'deploy':
        raise RuntimeError('Unsupported HA bridge operation')
    current_resource = re.findall(RESOURCE, (checkout / 'configuration.yaml').read_text())
    if current_resource[0] not in [release['previousUrl'], release['url']]:
        raise RuntimeError('Bridge resource changed since the prepared release')
    static = checkout / 'www/apartment-hotel'
    for path, want in expected.items():
        if hashlib.sha256((static / path).read_bytes()).hexdigest() != want:
            raise RuntimeError('Bridge asset hash does not match the prepared release')
    publisher = checkout / 'custom_components/apartment_hotel/public_snapshot.py'
    publisher_sha = hashlib.sha256(publisher.read_bytes()).hexdigest()
    if publisher_sha != request['publisher_sha256']:
        raise RuntimeError('Bridge outbound allowlist does not match the source')
    options = ['scp', '-B', *SSH_OPTIONS, '-i', str(identity), '--']
    subprocess.run([*options, str(publisher), target + ':/config/custom_components/apartment_hotel/public_snapshot.py'], check=True, timeout=120, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    subprocess.run(['scp', '-r', '-B', *SSH_OPTIONS, '-i', str(identity), '--', str(static / 'models'), str(static / 'sprites'), target + ':/config/www/apartment-hotel/'], check=True, timeout=300, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    subprocess.run([*options, str(static / release['card']), target + ':/config/www/apartment-hotel/'], check=True, timeout=120, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    actual = ssh(identity, target, ['sha256sum', '/config/custom_components/apartment_hotel/public_snapshot.py'], capture=True).split()
    if not actual or actual[0] != publisher_sha:
        raise RuntimeError('Public material allowlist did not deploy')
    patch = '''set -e
count=$(grep -c '/local/apartment-hotel/apartment-hotel-card' /config/configuration.yaml || true)
test "$count" -eq 1
current=$(grep -o '/local/apartment-hotel/apartment-hotel-card[^[:space:]]*' /config/configuration.yaml)
test "$current" = ''' + shlex.quote(release['previousUrl']) + ''' || test "$current" = ''' + shlex.quote(release['url']) + '''
cp /config/configuration.yaml /config/configuration.yaml.before-apartment-furniture
awk -v replacement=''' + shlex.quote(release['url']) + ''' '/url: \\/local\\/apartment-hotel\\/apartment-hotel-card/ {sub(/\\/local\\/apartment-hotel\\/[^ ]+/,replacement)} {print}' /config/configuration.yaml > /config/configuration.yaml.apartment-new
grep -Fq -- ''' + shlex.quote(release['url']) + ''' /config/configuration.yaml.apartment-new
mv /config/configuration.yaml.apartment-new /config/configuration.yaml
ha core check
ha core restart
'''
    ssh(identity, target, ['sh', '-s'], input=patch)
    config_path = checkout / 'configuration.yaml'
    text = config_path.read_text()
    # The staging checkout may also be the bridge checkout. Keep this idempotent.
    current = re.findall(RESOURCE, text)
    if len(current) != 1:
        raise RuntimeError('Expected exactly one existing apartment card resource')
    if current[0] != release['url']:
        config_path.write_text(re.sub(RESOURCE, lambda match: release['url'], text, count=1))
    return {'deployed': release['url']}


if __name__ == '__main__':
    result = handle(json.load(sys.stdin))
    print(json.dumps(result))
