"""Publish a public copy after local saves. Failures cannot block private saves."""
import asyncio
from datetime import timedelta
import json
import logging
import math
from homeassistant.core import callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.event import async_track_time_interval
from .public_snapshot import export_public_layout

_LOGGER = logging.getLogger(__name__)


class PublicSync:
    def __init__(self, hass, repository, url, token, lounge_entities=()):
        self.hass, self.repository, self.url, self.token = hass, repository, url, token
        self.lounge_entities = tuple(lounge_entities)
        self.lock = asyncio.Lock()
        self.last = None
        self.remove_timer = async_track_time_interval(hass, self.schedule, timedelta(minutes=1))

    @callback
    def schedule(self, *_):
        self.hass.async_create_task(self.publish())

    def setting(self, name, fallback):
        state = self.hass.states.get(name)
        try:
            value = float(state.state) if state else fallback
            return min(100, max(0, value)) if math.isfinite(value) else fallback
        except (TypeError, ValueError):
            return fallback

    async def publish(self):
        async with self.lock:
            current = self.repository.current()
            if current is None:
                return
            data = export_public_layout(current, self.setting, self.lounge_entities)
            serialized = json.dumps(data, sort_keys=True, allow_nan=False)
            if serialized == self.last:
                return
            try:
                async with asyncio.timeout(15):
                    session = async_get_clientsession(self.hass)
                    async with session.put(self.url, json=data,
                                           headers={'Authorization': 'Bearer ' + self.token},
                                           allow_redirects=False) as response:
                        if response.status != 200:
                            _LOGGER.warning('Public apartment sync returned HTTP %s; will retry', response.status)
                            return
                        self.last = serialized
            except (TimeoutError, OSError):
                _LOGGER.warning('Public apartment sync unavailable; will retry')
            except Exception:
                # Keep URLs, tokens and payloads out of logs and leave the private save intact.
                _LOGGER.warning('Public apartment sync failed; will retry')
