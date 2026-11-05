"""Private, authenticated apartment layouts using Home Assistant's atomic storage."""
import json
from pathlib import Path
import logging
import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.helpers.storage import Store
from .layout_store import LayoutRepository, LayoutConflict
from .public_sync import PublicSync
from urllib.parse import urlparse

DOMAIN = "apartment_hotel"
CONFIG_SCHEMA = vol.Schema({vol.Optional(DOMAIN): vol.Schema({vol.Optional("public_sync_url"): str, vol.Optional("public_sync_token"): str, vol.Optional("public_lounge_entities", default=[]): [str]})}, extra=vol.ALLOW_EXTRA)
_LOGGER = logging.getLogger(__name__)


async def async_setup(hass, config):
    repository = LayoutRepository(Store(hass, 1, DOMAIN + ".layout", private=True))
    seed_path = Path(hass.config.path("apartment_hotel_seed.json"))

    def read_seed():
        return json.loads(seed_path.read_text()) if seed_path.exists() else None

    await repository.load(await hass.async_add_executor_job(read_seed))
    hass.data[DOMAIN] = repository
    settings = config.get(DOMAIN, {})
    url, token = settings.get("public_sync_url"), settings.get("public_sync_token")
    if url and token:
        parsed = urlparse(url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path != "/api/layout":
            _LOGGER.error("Public sync requires an HTTPS /api/layout endpoint")
            return False
        publisher = PublicSync(hass, repository, url, token, settings.get("public_lounge_entities", []))
        hass.data[DOMAIN + "_public_sync"] = publisher
        publisher.schedule()
    websocket_api.async_register_command(hass, get_layout)
    websocket_api.async_register_command(hass, save_layout)
    websocket_api.async_register_command(hass, get_history)
    return True


@websocket_api.websocket_command({vol.Required("type"): "apartment_hotel/layout/get"})
@websocket_api.async_response
async def get_layout(hass, connection, msg):
    connection.send_result(msg["id"], hass.data[DOMAIN].current())


@websocket_api.websocket_command({
    vol.Required("type"): "apartment_hotel/layout/save",
    vol.Required("items"): list,
    vol.Required("expected_revision"): vol.All(int, vol.Range(min=0)),
    vol.Required("request_id"): vol.All(str, vol.Length(min=1, max=128)),
    vol.Optional("allow_empty", default=False): bool,
})
@websocket_api.async_response
async def save_layout(hass, connection, msg):
    try:
        saved = await hass.data[DOMAIN].save(msg["items"], msg["expected_revision"],
                                             msg["request_id"], msg["allow_empty"])
    except LayoutConflict as error:
        connection.send_error(msg["id"], "conflict", str(error))
        return
    except (ValueError, TypeError):
        connection.send_error(msg["id"], "invalid_layout", "Invalid apartment layout")
        return
    except Exception:
        _LOGGER.exception("Could not persist apartment layout")
        connection.send_error(msg["id"], "save_failed", "Layout could not be saved; your browser draft is retained")
        return
    connection.send_result(msg["id"], saved)
    publisher = hass.data.get(DOMAIN + "_public_sync")
    if publisher:
        publisher.schedule()


@websocket_api.websocket_command({vol.Required("type"): "apartment_hotel/layout/history"})
@websocket_api.async_response
async def get_history(hass, connection, msg):
    connection.send_result(msg["id"], hass.data[DOMAIN].history())
