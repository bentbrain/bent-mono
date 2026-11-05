import importlib.util
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
from contextlib import ExitStack, contextmanager
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / 'scripts'))
spec = importlib.util.spec_from_file_location('release_both', Path(__file__).parents[1] / 'scripts/release_both.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
SHA = 'a' * 40


@contextmanager
def operator(preflight=None):
    with ExitStack() as stack:
        stack.enter_context(patch.object(module, 'load_config', return_value=SimpleNamespace(checkout=Path('/synthetic-ha'))))
        transport = stack.enter_context(patch.object(module, 'HATransport'))
        transport.return_value.preflight.side_effect = preflight
        yield transport


class PairedReleaseTests(unittest.TestCase):
    def test_source_requires_an_exact_clean_checkout(self):
        for output in [['short'], [SHA, ' M changed-file']]:
            with patch.object(module.subprocess, 'check_output', side_effect=output):
                with self.assertRaises(RuntimeError):
                    module.source_revision()
        with patch.object(module.subprocess, 'check_output', side_effect=[SHA + '\n', '']):
            self.assertEqual(module.source_revision(), SHA)

    def test_public_readiness_requires_exact_revision_and_existing_schema(self):
        for documents in [
            [{'sourceRevision': 'b' * 40}],
            [{'sourceRevision': SHA, 'extra': True}],
            [{'sourceRevision': SHA}, {'schema': 2}],
        ]:
            with patch.object(module, 'public_json', side_effect=documents):
                with self.assertRaises(RuntimeError):
                    module.verify_public_release(SHA)
        with patch.object(module, 'public_json', side_effect=[{'sourceRevision': SHA}, {'schema': 1}]):
            module.verify_public_release(SHA)

    def test_gate_pins_source_and_calls_root_checker(self):
        with patch.object(module, 'source_revision', return_value='b' * 40), patch.object(module, 'run') as run:
            with self.assertRaises(RuntimeError):
                module.require_release_checks(SHA)
            run.assert_not_called()
        with patch.object(module, 'source_revision', return_value=SHA), patch.object(module, 'run') as run:
            module.require_release_checks(SHA)
            run.assert_called_once_with('node', str(module.root.parents[1] / 'scripts/require-release-checks.mjs'), '--sha', SHA)

    def test_failed_public_readiness_or_second_gate_never_advances_private_card(self):
        for ready_error, gate_errors in [(RuntimeError('stale public revision'), [None]), (None, [None, RuntimeError('new main')])]:
            with operator(), patch.object(module, 'source_revision', return_value=SHA), patch.object(module, 'run') as run, patch.object(module, 'require_release_checks', side_effect=gate_errors), patch.object(module, 'verify_public_release', side_effect=ready_error):
                with self.assertRaises(RuntimeError):
                    module.main()
                self.assertFalse(any('scripts/prepare_ha_release.py' in item.args for item in run.call_args_list))
                self.assertFalse(any('scripts/deploy_ha_release.py' in item.args for item in run.call_args_list))

    def test_unreachable_private_route_leaves_public_and_private_mutations_unstarted(self):
        with operator(RuntimeError('Synthetic HA unavailable')) as transport, patch.object(module, 'source_revision', return_value=SHA), patch.object(module, 'run') as run, patch.object(module, 'require_release_checks') as gate:
            with self.assertRaises(RuntimeError):
                module.main()
            transport.return_value.preflight.assert_called_once()
            gate.assert_not_called()
            for mutation in ['deploy:public', 'scripts/prepare_ha_release.py', 'scripts/deploy_ha_release.py', 'scripts/verify_ha_release.py']:
                self.assertFalse(any(mutation in item.args for item in run.call_args_list))

    def test_paired_release_orders_public_readiness_and_gate_before_private_mutation(self):
        events = []
        with tempfile.TemporaryDirectory() as directory, operator(), patch.object(module, 'root', Path(directory)), patch.object(module, 'source_revision', return_value=SHA), patch.object(module, 'run', side_effect=lambda *args, **kwargs: events.append(('run', args, kwargs))), patch.object(module, 'require_release_checks', side_effect=lambda sha: events.append(('gate', sha))), patch.object(module, 'verify_public_release', side_effect=lambda sha: events.append(('ready', sha))):
            module.main()
        deploy = next(index for index, event in enumerate(events) if event[:2] == ('run', ('bun', 'run', 'deploy:public')))
        prepare = next(index for index, event in enumerate(events) if event[:2] == ('run', ('python3', 'scripts/prepare_ha_release.py', '/synthetic-ha')))
        self.assertEqual(events[deploy - 1], ('gate', SHA))
        self.assertEqual(events[deploy + 1], ('ready', SHA))
        self.assertEqual(events[prepare - 1], ('gate', SHA))
        self.assertEqual(events[deploy][2]['env']['HOME_RELEASE_SHA'], SHA)


if __name__ == '__main__':
    unittest.main()
