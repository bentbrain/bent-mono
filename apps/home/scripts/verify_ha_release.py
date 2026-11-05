"""Verify every prepared asset through the existing bridge's HA HTTP route."""
import json
from pathlib import Path
from ha_bridge import HATransport
from ha_config import load_config

root = Path(__file__).resolve().parents[1]


def main():
    expected = json.loads((root / 'runs/furniture-audit/deployed-files.json').read_text())
    release = json.loads((root / 'dist-card/release.json').read_text())
    result = HATransport(load_config()).invoke('verify', release=release, expected=expected)
    if result.get('verified') != len(expected):
        raise RuntimeError('Not every prepared asset was verified')
    print('Verified all served apartment assets by SHA-256.')


if __name__ == '__main__':
    main()
