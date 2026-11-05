"""Private deployment settings supplied by the operator's environment."""
import os
from pathlib import Path
from shlex import quote

def required(name):
    value=os.environ.get(name,'')
    if not value.strip() or any(character in value for character in '\r\n\0'):
        raise RuntimeError('Configure '+name+' before releasing Home')
    return value

checkout=Path(required('HOME_ASSISTANT_CHECKOUT')).expanduser().resolve()
bridge=required('HOME_ASSISTANT_BRIDGE')
bridge_checkout=required('HOME_ASSISTANT_BRIDGE_CHECKOUT')
ssh_identity=quote(required('HOME_ASSISTANT_SSH_IDENTITY'))
ssh_target=quote(required('HOME_ASSISTANT_SSH_TARGET'))
ssh_command='ssh -i '+ssh_identity+' '+ssh_target
ha_url=required('HOME_ASSISTANT_URL').rstrip('/')
