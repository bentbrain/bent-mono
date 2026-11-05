"""Allowlisted, one-way public scene data. Never exports HA entity bindings."""
from hashlib import sha256

FIELDS = ('productId', 'x', 'z', 'rotation', 'elevation', 'finish', 'materialColor', 'materialGloss', 'seatPad', 'bedding')
RAMP_FIELDS = {
    'lampsStart': ('lamp_ramp_start', 0), 'lampsEnd': ('lamp_ramp_end', 100),
    'pendantStart': ('pendant_ramp_start', 25), 'pendantEnd': ('pendant_ramp_end', 100),
    'overheadsStart': ('overhead_ramp_start', 50), 'overheadsEnd': ('overhead_ramp_end', 100),
}


def public_id(value):
    return 'p-' + sha256(value.encode()).hexdigest()[:16]


def export_public_layout(snapshot, get_setting=lambda name, fallback: fallback, lounge_entities=()):
    ids = {item['id']: public_id(item['id']) for item in snapshot['items']}
    items, roles = [], {}
    for source in snapshot['items']:
        item = {key: source[key] for key in FIELDS if key in source}
        item.update(id=ids[source['id']], entityId='')
        support = source.get('supportId')
        if support:
            if support in ids:
                item['supportId'] = ids[support]
            elif support.startswith('fixed/'):
                item['supportId'] = support
        surface = source.get('supportSurface')
        if surface:
            for old, new in ids.items():
                surface = surface.replace(old, new)
            item['supportSurface'] = surface
        entity = source.get('entityId', '')
        role = 'bedroom-lamps' if source['x'] > 4.8 else 'lounge-lamps'
        if 'bedside' in entity or source['productId'] == 'dejsa':
            role = 'bedroom-bedside'
        elif source['productId'] == 'downlight':
            role = 'bedroom-overheads' if source['x'] > 4.8 else 'lounge-overheads'
        elif source['productId'] == 'gullsudare':
            role = 'lounge-pendant'
        elif entity in lounge_entities:
            role = 'lounge-lamps'
        roles[item['id']] = role
        items.append(item)
    ramps = {key: get_setting('input_number.living_room_' + suffix, fallback)
             for key, (suffix, fallback) in RAMP_FIELDS.items()}
    return {'schema': 1, 'revision': snapshot['revision'], 'items': items, 'roles': roles, 'ramps': ramps}
