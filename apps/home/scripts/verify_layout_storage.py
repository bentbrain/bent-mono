from ha_config import checkout, bridge, bridge_checkout, ssh_identity, ssh_target, ssh_command, ha_url
"""Compare HA's durable layout with the recovered backup without printing its contents."""
from pathlib import Path
import subprocess,json,hashlib,sys
root=Path(__file__).resolve().parents[1]
result=subprocess.run(['ssh',bridge,ssh_command+' cat /config/.storage/apartment_hotel.layout'],capture_output=True,text=True,check=True)
raw=json.loads(result.stdout)
current=raw['data']['current'];expected=json.loads(Path(sys.argv[1]).read_text())
assert current['items']==expected,'Server layout differs from recovered backup'
(root/'backups/2026-09-10-recovery/ha-shared-layout.json').write_text(result.stdout)
print('Verified HA storage:',len(current['items']),'items; revision',current['revision'],'; exact match with recovery backup')
