import asyncio
from copy import deepcopy
import importlib.util
from pathlib import Path
import unittest
spec = importlib.util.spec_from_file_location('layout_store', Path(__file__).parents[1] / 'custom_components/apartment_hotel/layout_store.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
ITEM = dict(id='lamp', productId='kd27', entityId='light.test', x=2, z=3, rotation=0, finish='orange')

class MemoryStore:
    def __init__(self): self.data = None; self.fail = False
    async def async_load(self): return deepcopy(self.data)
    async def async_save(self, data):
        if self.fail: raise OSError('disk full')
        self.data = deepcopy(data)

class RepositoryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.store = MemoryStore(); self.repo = module.LayoutRepository(self.store)
        await self.repo.load([ITEM])
    async def test_seed_never_replaces_existing_and_history_restores(self):
        await self.repo.save([{**ITEM,'x':3}],1,'change')
        again=module.LayoutRepository(self.store); await again.load([{**ITEM,'x':9}])
        self.assertEqual(again.current()['items'][0]['x'],3)
        self.assertEqual(again.history()[0]['items'],[ITEM])
    async def test_empty_and_stale_clients_cannot_overwrite(self):
        with self.assertRaises(ValueError): await self.repo.save([],1,'empty')
        with self.assertRaises(module.LayoutConflict): await self.repo.save([],0,'stale',True)
        self.assertEqual(self.repo.current()['items'],[ITEM])
    async def test_two_concurrent_writers_only_one_wins(self):
        results=await asyncio.gather(self.repo.save([{**ITEM,'x':3}],1,'a'),self.repo.save([{**ITEM,'x':4}],1,'b'),return_exceptions=True)
        self.assertEqual(sum(isinstance(r,module.LayoutConflict) for r in results),1)
        self.assertEqual(self.repo.current()['revision'],2)
    async def test_acknowledgement_requires_durable_save(self):
        self.store.fail=True
        with self.assertRaises(OSError): await self.repo.save([{**ITEM,'x':3}],1,'a')
        self.assertEqual(self.repo.current()['revision'],1)
        self.assertEqual(self.repo.current()['items'],[ITEM])
    async def test_lost_response_retry_is_idempotent(self):
        a=await self.repo.save([{**ITEM,'x':3}],1,'a')
        self.assertEqual(await self.repo.save([{**ITEM,'x':3}],1,'a'),a)
        self.assertEqual(len(self.repo.history()),1)
    async def test_invalid_positions_rejected(self):
        with self.assertRaises(ValueError): await self.repo.save([{**ITEM,'x':float('nan')}],1,'a')

if __name__=='__main__': unittest.main()
