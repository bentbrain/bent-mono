import {loadEnv} from 'vite';

export function locationDefines(mode: string): Record<string, string> {
  const env = {...loadEnv(mode, process.cwd(), ''), ...process.env};
  const defines: Record<string, string> = {};
  for (const name of ['PUBLIC_HOME_LATITUDE', 'PUBLIC_HOME_LONGITUDE', 'PUBLIC_HOME_BALCONY_BEARING', 'PUBLIC_HOME_ALTITUDE_METRES']) {
    const value = env[name];
    if (value === undefined || value.trim() === '' || !Number.isFinite(Number(value))) {
      throw new Error(`Configure ${name} before building Home`);
    }
    defines[`process.env.${name}`] = JSON.stringify(value);
  }
  defines['process.env.PUBLIC_HOME_HA_BINDINGS'] = JSON.stringify(env.PUBLIC_HOME_HA_BINDINGS ?? '{}');
  return defines;
}
