import {afterEach, expect, test} from 'bun:test';
import {locationDefines} from '../config/location';
import {releaseDefines} from '../config/release';
import {execFileSync} from 'node:child_process';

const locationNames = ['PUBLIC_HOME_LATITUDE', 'PUBLIC_HOME_LONGITUDE', 'PUBLIC_HOME_BALCONY_BEARING', 'PUBLIC_HOME_ALTITUDE_METRES'];
const environmentNames = [...locationNames, 'PUBLIC_HOME_HA_BINDINGS', 'HOME_RELEASE_SHA'];
const originalEnvironment = new Map(environmentNames.map(name => [name, process.env[name]]));

afterEach(() => {
  for (const [name, value] of originalEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test('private card receives protected HA bindings while public builds always remove them', () => {
  delete process.env.PUBLIC_HOME_HA_BINDINGS;
  const defines = locationDefines('test', 'card');
  for (const name of locationNames) {
    expect(JSON.parse(defines[`process.env.${name}`] ?? '')).toBe(process.env[name]);
  }
  expect(defines['process.env.PUBLIC_HOME_HA_BINDINGS']).toBe(JSON.stringify('{}'));
  const bindings = JSON.stringify({vacuum: {entityId: 'vacuum.synthetic'}});
  process.env.PUBLIC_HOME_HA_BINDINGS = bindings;
  expect(locationDefines('test', 'card')['process.env.PUBLIC_HOME_HA_BINDINGS']).toBe(JSON.stringify(bindings));
  expect(locationDefines('test', 'public')['process.env.PUBLIC_HOME_HA_BINDINGS']).toBe(JSON.stringify('{}'));
  process.env.PUBLIC_HOME_HA_BINDINGS = 'invalid-private-configuration';
  expect(locationDefines('test', 'public')['process.env.PUBLIC_HOME_HA_BINDINGS']).toBe(JSON.stringify('{}'));
});

test('build configuration fails closed when any required solar setting is absent or invalid', () => {
  for (const name of locationNames) {
    const original = process.env[name];
    for (const invalid of [undefined, '', ' ', 'not-a-number', 'Infinity']) {
      if (invalid === undefined) delete process.env[name];
      else process.env[name] = invalid;
      expect(() => locationDefines('test', 'card')).toThrow(`Configure ${name} before building Home`);
    }
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
});


test('public readiness marker pins the exact source revision and rejects a mismatched release override', () => {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
  delete process.env.HOME_RELEASE_SHA;
  expect(releaseDefines()['process.env.PUBLIC_HOME_RELEASE_SHA']).toBe(JSON.stringify(sha));
  process.env.HOME_RELEASE_SHA = sha;
  expect(releaseDefines()['process.env.PUBLIC_HOME_RELEASE_SHA']).toBe(JSON.stringify(sha));
  for (const value of ['', 'main', '0'.repeat(40)]) {
    process.env.HOME_RELEASE_SHA = value;
    expect(() => releaseDefines()).toThrow('Home release revision must match the exact source commit');
  }
});
