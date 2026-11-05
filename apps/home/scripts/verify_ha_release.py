from ha_config import checkout, bridge, bridge_checkout, ssh_identity, ssh_target, ssh_command, ha_url
"""Verify every deployed asset over the same HA HTTP endpoint used by the dashboard."""
import pathlib,json,subprocess
root=pathlib.Path(__file__).resolve().parents[1];expected=json.loads((root/'runs/furniture-audit/deployed-files.json').read_text())
script='import urllib.request,hashlib,json\nbase_url='+repr(ha_url+'/local/apartment-hotel/')+'\nexpected='+repr(expected)+'''\nfor path,want in expected.items():
 data=urllib.request.urlopen(base_url+path,timeout=10).read()
 got=hashlib.sha256(data).hexdigest()
 if got!=want:raise RuntimeError('Mismatch: '+path)
print('Verified',len(expected),'served files by SHA-256')
'''
subprocess.run(['ssh',bridge,'python3 -'],input=script,text=True,check=True)
