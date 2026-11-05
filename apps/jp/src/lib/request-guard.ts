// These files and platforms are not served by this application. Match only
// their root paths so similarly named posts, uploads and well-known URLs work.
const probes = new Set([
  '/.env',
  '/.env.local',
  '/.env.production',
  '/.git',
  '/.svn',
  '/wp-login.php',
  '/xmlrpc.php',
  '/phpinfo.php',
  '/admin_phpinfo.php',
  '/administrator/.env',
  '/config/aws.json',
  '/dnscfg.cgi',
  '/package-updates/perform.cgi',
  '/servers/link.cgi',
]);

export function isKnownProbe(path: string): boolean {
  for (let depth = 0; depth < 4 && path.includes('%'); depth++) {
    try {
      path = decodeURIComponent(path);
    } catch {
      return false;
    }
  }
  path = path.toLowerCase();
  return (
    probes.has(path) || path.startsWith('/.git/') || path.startsWith('/.svn/')
  );
}
