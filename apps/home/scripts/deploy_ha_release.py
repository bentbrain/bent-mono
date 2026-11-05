"""Deploy a prepared card through the configured bridge and existing HA SSH."""
import json
from pathlib import Path
import subprocess
from ha_bridge import HATransport
from ha_config import load_config

root = Path(__file__).resolve().parents[1]


def main():
    config = load_config()
    subprocess.run(['python3', str(root / 'scripts/prepare_ha_release.py'), str(config.checkout), '--check'], check=True)
    release = json.loads((root / 'dist-card/release.json').read_text())
    expected = HATransport(config).deploy(release, root / 'custom_components/apartment_hotel/public_snapshot.py')
    evidence = root / 'runs/furniture-audit/deployed-files.json'
    evidence.parent.mkdir(parents=True, exist_ok=True)
    evidence.write_text(json.dumps(expected, indent=2) + '\n')
    print('Deployed prepared apartment card; verify served files after restart.')


if __name__ == '__main__':
    main()
