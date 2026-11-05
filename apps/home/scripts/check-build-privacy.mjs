import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';

// This command only builds synthetic test artifacts. Production rebuilds from
// its protected location configuration after the release gate passes.
const canary = 'synthetic_private_binding_canary_4eaf';
const env = {
  ...process.env,
  PUBLIC_HOME_LATITUDE: '-27.5',
  PUBLIC_HOME_LONGITUDE: '153',
  PUBLIC_HOME_BALCONY_BEARING: '41',
  PUBLIC_HOME_ALTITUDE_METRES: '10',
  PUBLIC_HOME_HA_BINDINGS: JSON.stringify({television: `media_player.${canary}`}),
};
for (const script of ['build', 'build:card']) {
  const result = spawnSync('bun', ['run', script], {env, stdio: 'inherit'});
  if (result.status !== 0 || result.signal) throw new Error(`Privacy fixture ${script} failed`);
}
async function contains(directory) {
  let found = false;
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found = await contains(path) || found;
    else if (entry.isFile() && (await readFile(path)).includes(Buffer.from(canary))) found = true;
  }
  return found;
}
assert.equal(await contains('dist'), false, 'Private HA binding entered public build artifacts');
assert.equal(await contains('dist-card'), true, 'Private card lost its configured HA binding');
console.log('Built public artifacts exclude private bindings; the private card retains them.');
