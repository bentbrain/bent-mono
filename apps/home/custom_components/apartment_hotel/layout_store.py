"""Revision-checked layout storage. Persistence must succeed before acknowledging a save."""
import asyncio
from copy import deepcopy
from datetime import datetime, timezone
import json
import math


class LayoutConflict(Exception):
    pass


def validate_items(items):
    if not isinstance(items, list) or len(items) > 200:
        raise ValueError("A layout must contain at most 200 items")
    if len(json.dumps(items, allow_nan=False)) > 200_000:
        raise ValueError("Layout is too large")
    ids = set()
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("Invalid item")
        for key in ("id", "productId", "entityId"):
            if not isinstance(item.get(key), str) or len(item[key]) > 256:
                raise ValueError("Invalid item identifier")
        if not item["id"] or item["id"] in ids:
            raise ValueError("Duplicate or empty item identifier")
        ids.add(item["id"])
        for key in ("x", "z"):
            if type(item.get(key)) not in (int, float) or not math.isfinite(item[key]):
                raise ValueError("Invalid item position")
        if type(item.get("rotation")) is not int or item["rotation"] not in range(4):
            raise ValueError("Invalid rotation")
    return deepcopy(items)


class LayoutRepository:
    def __init__(self, store):
        self.store = store
        self.lock = asyncio.Lock()
        self.data = None

    async def load(self, seed=None):
        self.data = await self.store.async_load()
        if self.data is None and seed is not None:
            items = validate_items(seed)
            if not items:
                raise ValueError("Refusing an empty migration seed")
            data = {"current": {"revision": 1, "items": items,
                               "updatedAt": datetime.now(timezone.utc).isoformat(),
                               "requestId": "migration-original"}, "history": []}
            await self.store.async_save(data)
            self.data = data
        if self.data is not None:
            validate_items(self.data["current"]["items"])
        return self.current()

    def current(self):
        return deepcopy(self.data["current"]) if self.data else None

    async def save(self, items, expected_revision, request_id, allow_empty=False):
        items = validate_items(items)
        async with self.lock:
            current = self.current()
            if current and current.get("requestId") == request_id:
                if current["items"] != items:
                    raise LayoutConflict("Save identifier was reused with different content")
                return current
            revision = current["revision"] if current else 0
            if expected_revision != revision:
                raise LayoutConflict("A newer layout exists. Your draft has been kept in this browser.")
            if not items and current and current["items"] and not allow_empty:
                raise ValueError("Refusing to replace a furnished layout with an empty one")
            snapshot = {"revision": revision + 1, "items": items,
                        "updatedAt": datetime.now(timezone.utc).isoformat(), "requestId": request_id}
            history = [*self.data["history"], current][-50:] if self.data else []
            data = {"current": snapshot, "history": history}
            await self.store.async_save(data)
            self.data = data
            return deepcopy(snapshot)

    def history(self):
        return deepcopy(self.data["history"]) if self.data else []
