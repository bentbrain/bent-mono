from ha_config import checkout, bridge, bridge_checkout, ssh_identity, ssh_target, ssh_command, ha_url
"""Release the shared scene to the public Worker, then the private HA card."""
from pathlib import Path
import subprocess
import json

root = Path(__file__).resolve().parents[1]
# checkout is supplied by HOME_ASSISTANT_CHECKOUT

def run(*args):
    subprocess.run(args, cwd=root, check=True)

run('bun', 'run', 'typecheck')
run('bun', 'run', 'lint')
run('bun', 'run', 'test')
run('python3', '-m', 'unittest', 'discover', '-s', 'tests')
run('bun', 'run', 'build:card')
run('bun', 'run', 'deploy:public')
response = subprocess.check_output(['curl', '--fail', '--silent', '--show-error', '--retry', '3', 'https://home.bent.build/api/layout'], text=True)
if json.loads(response).get('schema') != 1:
    raise RuntimeError('Public release is not ready; private release left unchanged')
run('python3', 'scripts/prepare_ha_release.py', str(checkout))
(root / 'runs/furniture-audit').mkdir(parents=True, exist_ok=True)
run('python3', 'scripts/deploy_ha_release.py')
run('python3', 'scripts/verify_ha_release.py')
print('Both apartment apps deployed and verified.')
