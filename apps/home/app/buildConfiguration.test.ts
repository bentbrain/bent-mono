import {afterEach, expect, test} from 'bun:test';
import {locationDefines} from '../config/location';

const locationNames = ['PUBLIC_HOME_LATITUDE', 'PUBLIC_HOME_LONGITUDE', 'PUBLIC_HOME_BALCONY_BEARING', 'PUBLIC_HOME_ALTITUDE_METRES'];
const environmentNames = [...locationNames, 'PUBLIC_HOME_HA_BINDINGS'];
const originalEnvironment = new Map(environmentNames.map(name => [name, process.env[name]]));

afterEach(() => {
  for (const [name, value] of originalEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test('both build targets receive explicit solar settings and optional protected HA bindings', () => {
  delete process.env.PUBLIC_HOME_HA_BINDINGS;
  const defines = locationDefines('test');
  for (const name of locationNames) {
    expect(JSON.parse(defines[`process.env.${name}`] ?? '')).toBe(process.env[name]);
  }
  expect(defines['process.env.PUBLIC_HOME_HA_BINDINGS']).toBe(JSON.stringify('{}'));
  const bindings = JSON.stringify({vacuum: {entityId: 'vacuum.synthetic'}});
  process.env.PUBLIC_HOME_HA_BINDINGS = bindings;
  expect(locationDefines('test')['process.env.PUBLIC_HOME_HA_BINDINGS']).toBe(JSON.stringify(bindings));
});

test('build configuration fails closed when any required solar setting is absent or invalid', () => {
  for (const name of locationNames) {
    const original = process.env[name];
    for (const invalid of [undefined, '', ' ', 'not-a-number', 'Infinity']) {
      if (invalid === undefined) delete process.env[name];
      else process.env[name] = invalid;
      expect(() => locationDefines('test')).toThrow(`Configure ${name} before building Home`);
    }
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
});
