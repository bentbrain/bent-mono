import {execFileSync} from 'node:child_process';

export function releaseDefines(): Record<string, string> {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
  if (!/^[a-f0-9]{40}$/.test(sha) ||
      (process.env.HOME_RELEASE_SHA !== undefined && process.env.HOME_RELEASE_SHA !== sha)) {
    throw new Error('Home release revision must match the exact source commit');
  }
  return {'process.env.PUBLIC_HOME_RELEASE_SHA': JSON.stringify(sha)};
}
