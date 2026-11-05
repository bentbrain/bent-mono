"""Private operator configuration, loaded only when a release is requested."""
from dataclasses import dataclass
import os
from pathlib import Path
import re
from urllib.parse import urlsplit


def required(environment, name):
    value = environment.get(name, '')
    if not value.strip() or any(character in value for character in '\r\n\0'):
        raise RuntimeError('Configure ' + name + ' before releasing Home')
    return value


@dataclass(frozen=True)
class HAConfig:
    checkout: Path
    bridge_mode: str
    bridge: str | None
    bridge_checkout: str
    ssh_identity: str
    ssh_target: str
    ha_url: str


def load_config(environment=None):
    environment = os.environ if environment is None else environment
    mode = environment.get('HOME_ASSISTANT_BRIDGE_MODE', 'ssh')
    if mode not in ('local', 'ssh'):
        raise RuntimeError('HOME_ASSISTANT_BRIDGE_MODE must be local or ssh')
    bridge = required(environment, 'HOME_ASSISTANT_BRIDGE') if mode == 'ssh' else None
    if bridge is not None and (bridge.startswith('-') or not re.fullmatch(r'[\w.@:\[\]-]+', bridge)):
        raise RuntimeError('Invalid HOME_ASSISTANT_BRIDGE')
    target = required(environment, 'HOME_ASSISTANT_SSH_TARGET')
    if not re.fullmatch(r'root@[\w.:\[\]-]+', target):
        raise RuntimeError('HOME_ASSISTANT_SSH_TARGET must identify the existing root SSH account')
    url = required(environment, 'HOME_ASSISTANT_URL').rstrip('/')
    parsed = urlsplit(url)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise RuntimeError('Invalid HOME_ASSISTANT_URL')
    return HAConfig(
        checkout=Path(required(environment, 'HOME_ASSISTANT_CHECKOUT')).expanduser().resolve(),
        bridge_mode=mode,
        bridge=bridge,
        bridge_checkout=required(environment, 'HOME_ASSISTANT_BRIDGE_CHECKOUT'),
        ssh_identity=required(environment, 'HOME_ASSISTANT_SSH_IDENTITY'),
        ssh_target=target,
        ha_url=url,
    )
