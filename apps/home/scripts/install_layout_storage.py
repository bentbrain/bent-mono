from ha_config import checkout, bridge, bridge_checkout, ssh_identity, ssh_target, ssh_command, ha_url
"""Install private HA storage with a recovered seed. Never overwrite an existing seed or layout."""
from pathlib import Path
import subprocess
import shutil
import json
import hashlib
import sys

root = Path(__file__).resolve().parents[1]
# checkout is supplied by HOME_ASSISTANT_CHECKOUT
seed = Path(sys.argv[1]).resolve()
items = json.loads(seed.read_text())
assert isinstance(items, list) and items, 'A non-empty recovered layout is required'
component = root / 'custom_components/apartment_hotel'
(checkout / 'custom_components').mkdir(exist_ok=True)
shutil.copytree(component, checkout / 'custom_components/apartment_hotel', dirs_exist_ok=True, ignore=shutil.ignore_patterns('__pycache__'))
(checkout / 'packages').mkdir(exist_ok=True)
package = checkout / 'packages/apartment_hotel_layout.yaml'
package.write_text('apartment_hotel: {}\n')
mini = bridge_checkout
subprocess.run(['ssh',bridge,f'mkdir -p {mini}/custom_components {mini}/packages'],check=True)
subprocess.run(['scp','-r',str(checkout / 'custom_components/apartment_hotel'),f'{bridge}:{mini}/custom_components/'],check=True)
subprocess.run(['scp',str(package),f'{bridge}:{mini}/packages/'],check=True)
# The seed is private data, never part of /www or the Git checkout.
remote_seed = '/tmp/apartment-hotel-recovered-seed.json'
subprocess.run(['scp',str(seed),f'{bridge}:{remote_seed}'],check=True)
commands = f'''set -e
ssh -n -i {ssh_identity} {ssh_target} 'mkdir -p /config/custom_components /config/apartment_hotel_backups'
scp -r -i {ssh_identity} {mini}/custom_components/apartment_hotel {ssh_target}:/config/custom_components/
scp -i {ssh_identity} {mini}/packages/apartment_hotel_layout.yaml {ssh_target}:/config/packages/
scp -i {ssh_identity} {remote_seed} {ssh_target}:/config/apartment_hotel_backups/recovered-upload.json
ssh -n -i {ssh_identity} {ssh_target} 'if [ ! -f /config/apartment_hotel_backups/original-2026-09-10.json ]; then cp /config/apartment_hotel_backups/recovered-upload.json /config/apartment_hotel_backups/original-2026-09-10.json; fi; if [ ! -f /config/apartment_hotel_seed.json ]; then cp /config/apartment_hotel_backups/original-2026-09-10.json /config/apartment_hotel_seed.json; fi; chmod 600 /config/apartment_hotel_seed.json /config/apartment_hotel_backups/original-2026-09-10.json'
'''
subprocess.run(['ssh',bridge,'sh -s'],input=commands,text=True,check=True)
subprocess.run(['ssh',bridge,f'ssh -n -i {ssh_identity} {ssh_target} \"test -f /config/custom_components/apartment_hotel/manifest.json && test -f /config/packages/apartment_hotel_layout.yaml && test -f /config/apartment_hotel_seed.json\"'],check=True)
print('Installed layout integration; recovered seed:',len(items),'items;',hashlib.sha256(seed.read_bytes()).hexdigest())
