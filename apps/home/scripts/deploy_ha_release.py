from ha_config import checkout, bridge, bridge_checkout, ssh_identity, ssh_target, ssh_command, ha_url
"""Deploy a prepared native card to the user's existing private Home Assistant.
Only Apartment Hotel's static folder, outbound allowlist and YAML resource URL are changed.
The prepare_ha_release.py --check step must pass first.
"""
import json,pathlib,subprocess,shlex,hashlib,shutil
root=pathlib.Path(__file__).resolve().parents[1]
static=checkout/'www/apartment-hotel'
subprocess.run(['python3',str(root/'scripts/prepare_ha_release.py'),str(checkout),'--check'],check=True)
release=json.loads((root/'dist-card/release.json').read_text());mini=bridge_checkout
subprocess.run(['scp',str(static/release['card']),f'{bridge}:{mini}/www/apartment-hotel/'],check=True)
for folder in ['models','sprites']:subprocess.run(['scp','-r',str(static/folder),f'{bridge}:{mini}/www/apartment-hotel/'],check=True)
# Keep the outbound allowlist in step with the public parser before HA restarts.
publisher=root/'custom_components/apartment_hotel/public_snapshot.py'
shutil.copy2(publisher,checkout/'custom_components/apartment_hotel/public_snapshot.py')
subprocess.run(['scp',str(publisher),f'{bridge}:{mini}/custom_components/apartment_hotel/public_snapshot.py'],check=True)
remote=ssh_command
copy=f'''set -e
scp -i {ssh_identity} {mini}/custom_components/apartment_hotel/public_snapshot.py {ssh_target}:/config/custom_components/apartment_hotel/public_snapshot.py
scp -r -i {ssh_identity} {mini}/www/apartment-hotel/models {mini}/www/apartment-hotel/sprites {ssh_target}:/config/www/apartment-hotel/
scp -i {ssh_identity} {mini}/www/apartment-hotel/{release['card']} {ssh_target}:/config/www/apartment-hotel/
'''
subprocess.run(['ssh',bridge,'sh -s'],input=copy,text=True,check=True)
publisher_hash=subprocess.check_output(['ssh',bridge,remote+' sha256sum /config/custom_components/apartment_hotel/public_snapshot.py'],text=True).split()[0]
if publisher_hash!=hashlib.sha256(publisher.read_bytes()).hexdigest():
    raise RuntimeError('Public material allowlist did not deploy')
patch=f'''set -e
cp /config/configuration.yaml /config/configuration.yaml.before-apartment-furniture
awk -v replacement={shlex.quote(release['url'])} '/url: \\/local\\/apartment-hotel\\/apartment-hotel-card/ {{sub(/\\/local\\/apartment-hotel\\/[^ ]+/,replacement)}} {{print}}' /config/configuration.yaml > /config/configuration.yaml.apartment-new
mv /config/configuration.yaml.apartment-new /config/configuration.yaml
ha core check
ha core restart
'''
subprocess.run(['ssh',bridge,remote+' sh -s'],input=patch,text=True,check=True)
mini_patch='import pathlib,re\np=pathlib.Path('+repr(mini+'/configuration.yaml')+');s=p.read_text();p.write_text(re.sub(r"/local/apartment-hotel/apartment-hotel-card(?:\\.[a-f0-9]{12})?\\.js(?:\\?[^\\s]+)?",'+repr(release['url'])+',s))\n'
subprocess.run(['ssh',bridge,'python3 -'],input=mini_patch,text=True,check=True)
files=[static/release['card'],*sorted((static/'models').glob('*')),*sorted((static/'sprites').glob('*.png'))]
expected={str(p.relative_to(static)):hashlib.sha256(p.read_bytes()).hexdigest() for p in files if p.is_file()}
(root/'runs/furniture-audit/deployed-files.json').write_text(json.dumps(expected,indent=2)+'\n')
print('Deployed',release['url'],'; verify served files after restart.')
