"""Release the shared scene to the public Worker, then the private HA card."""
from pathlib import Path
import subprocess
import json
import os
import re

root = Path(__file__).resolve().parents[1]


def run(*args, env=None):
    subprocess.run(args, cwd=root, check=True, env=env)


def source_revision():
    sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
    if not re.fullmatch(r'[a-f0-9]{40}', sha):
        raise RuntimeError('Home release requires an exact source commit')
    dirty = subprocess.check_output(['git', 'status', '--porcelain'], cwd=root, text=True)
    if dirty.strip():
        raise RuntimeError('Home release requires a clean source checkout')
    return sha


def require_release_checks(sha):
    if source_revision() != sha:
        raise RuntimeError('Home source changed during release')
    run('node', str(root.parents[1] / 'scripts/require-release-checks.mjs'), '--sha', sha)


def public_json(path):
    response = subprocess.check_output([
        'curl', '--fail', '--silent', '--show-error', '--retry', '3',
        'https://home.bent.build' + path,
    ], text=True)
    return json.loads(response)


def verify_public_release(sha):
    if public_json('/api/release') != {'sourceRevision': sha}:
        raise RuntimeError('Exact public release is not ready; private release left unchanged')
    if public_json('/api/layout').get('schema') != 1:
        raise RuntimeError('Public layout schema is not ready; private release left unchanged')


def main():
    from ha_config import checkout
    sha = source_revision()
    release_env = {**os.environ, 'HOME_RELEASE_SHA': sha}
    run('bun', 'run', 'typecheck')
    run('bun', 'run', 'lint')
    run('bun', 'run', 'test')
    run('python3', '-m', 'unittest', 'discover', '-s', 'tests')
    run('bun', 'run', 'build:card', env=release_env)
    require_release_checks(sha)
    # The public Vite target strips HA bindings even when the private card's
    # operator environment contains them. Both targets pin the same source SHA.
    run('bun', 'run', 'deploy:public', env=release_env)
    verify_public_release(sha)
    require_release_checks(sha)
    run('python3', 'scripts/prepare_ha_release.py', str(checkout))
    (root / 'runs/furniture-audit').mkdir(parents=True, exist_ok=True)
    run('python3', 'scripts/deploy_ha_release.py')
    run('python3', 'scripts/verify_ha_release.py')
    print('Both apartment apps deployed and verified.')


if __name__ == '__main__':
    main()
