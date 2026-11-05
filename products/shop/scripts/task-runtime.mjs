import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Node's native ABI, OS libraries and hosted runner images affect build/test
// results too. Use this for every repository Turbo entrypoint, not just browsers.
export function taskRuntimeKey(env = process.env, runtime = process) {
  return JSON.stringify({ node: runtime.version, platform: runtime.platform, arch: runtime.arch,
    imageOS: env.ImageOS ?? (env.VERCEL === '1' ? 'vercel' : 'local'), imageVersion: env.ImageVersion ?? 'local' });
}

export function taskRuntimeArgs(args, env = process.env) {
  const separator = args.indexOf('--');
  const options = separator < 0 ? args : args.slice(0, separator);
  const forwarded = separator < 0 ? [] : args.slice(separator);
  const fresh = env.CI_FRESH_VALIDATION === 'true';
  const selected = [];
  for (let index = 0; index < options.length; index++) {
    const option = options[index];
    if (fresh && option === '--cache') { index++; continue; }
    if (fresh && /^(?:--cache=|--force=)/.test(option)) continue;
    if (fresh && (option === '--force' || option === '--no-cache')) {
      if (['true', 'false'].includes(options[index + 1])) index++;
      continue;
    }
    selected.push(option);
  }
  return [...selected, '--cache-dir=.turbo/cache', ...(fresh ? ['--cache=local:w'] : []), ...forwarded];
}

if (import.meta.main) {
  const args = [fileURLToPath(new URL('../../../node_modules/turbo/bin/turbo', import.meta.url)),
    ...taskRuntimeArgs(process.argv.slice(2).some(arg => arg.startsWith("--filter")) ? process.argv.slice(2) : [...process.argv.slice(2), "--filter=@forever-tee/*"])];
  const result = spawnSync(process.execPath, args, {
    env: { ...process.env, CI_TASK_RUNTIME: taskRuntimeKey() }, stdio: 'inherit',
  });
  if (result.error) console.error(`Unable to start Turbo: ${result.error.message}`);
  process.exit(result.status ?? 1);
}
