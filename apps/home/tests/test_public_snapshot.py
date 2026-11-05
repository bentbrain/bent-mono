import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('public_snapshot', Path(__file__).parents[1] / 'custom_components/apartment_hotel/public_snapshot.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class PublicSnapshotTests(unittest.TestCase):
    def test_material_overrides_survive_public_export(self):
        item={'id':'chair','productId':'casalino','x':2,'z':3,'rotation':0,'entityId':'','materialColor':'#abcdef','materialGloss':.7}
        result=module.export_public_layout({'revision':5,'items':[item]})
        self.assertEqual(result['items'][0]['materialColor'],'#abcdef')
        self.assertEqual(result['items'][0]['materialGloss'],.7)
    def test_private_fields_are_removed_and_supports_are_preserved(self):
        parent = {'id':'private-parent','productId':'componibili','x':6,'z':1,'rotation':0,'entityId':'', 'private_note':'do not publish'}
        child = {'id':'private-child','productId':'dejsa','x':6,'z':1,'rotation':0,'entityId':'light.bedside_lamps','supportId':'private-parent','supportSurface':'private-parent-support','elevation':.67}
        result = module.export_public_layout({'revision':4,'items':[parent,child],'requestId':'private-request'})
        self.assertEqual(result['items'][1]['supportId'],result['items'][0]['id'])
        self.assertEqual(result['items'][1]['supportSurface'],result['items'][0]['id']+'-support')
        self.assertEqual(result['roles'][result['items'][1]['id']],'bedroom-bedside')
        self.assertNotIn('private',str(result))
        self.assertNotIn('light.bedside',str(result))
        self.assertEqual(parent['id'],'private-parent')
    def test_private_entity_role_override_is_configurable_and_never_exported(self):
        item = {'id':'lamp','productId':'okensand','x':6,'z':2,'rotation':0,'entityId':'light.example_override'}
        result = module.export_public_layout({'revision':1,'items':[item]}, lounge_entities=['light.example_override'])
        self.assertEqual(result['roles'][result['items'][0]['id']], 'lounge-lamps')
        self.assertNotIn('light.example_override', str(result))
    def test_ramp_settings_export_configuration_only(self):
        output=module.export_public_layout({'revision':5,'items':[]},lambda key, default:35 if key.endswith('pendant_ramp_start') else default)
        self.assertEqual(output['ramps']['pendantStart'],35)
        self.assertNotIn('states',output)

if __name__=='__main__':unittest.main()
