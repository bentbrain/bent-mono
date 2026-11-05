// Match the original path before URL parsing can normalize dot segments or escapes.
const profileUrl =
  /^(?:https?:\/\/)?(?:www\.)?instagram\.com\/([a-z0-9_](?:[a-z0-9_.]{0,28}[a-z0-9_])?)\/?(?:[?#][^\s\\]*)?$/i;
const reservedPaths = new Set([
  'about',
  'accounts',
  'ads',
  'api',
  'challenge',
  'developer',
  'developers',
  'direct',
  'directory',
  'emails',
  'explore',
  'graphql',
  'legal',
  'oauth',
  'p',
  'press',
  'privacy',
  'reel',
  'reels',
  'share',
  'stories',
  'terms',
  'tv',
  'web',
  'your_activity',
]);

export function instagramProfile(value: string) {
  const username = profileUrl.exec(value.trim())?.[1];
  if (
    !username ||
    username.includes('..') ||
    reservedPaths.has(username.toLowerCase())
  )
    return null;
  return {
    handle: `@${username}`,
    href: `https://www.instagram.com/${username}/`,
  };
}
