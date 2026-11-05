import { useEffect, useState } from 'react';
import { Menu } from '@base-ui/react/menu';

const destinations = [
  { href: '/owner', label: 'posts' },
  { href: '/owner/media', label: 'media' },
  { href: '/categories', label: 'categories' },
  { href: '/owner/newsletter', label: 'newsletter' },
  { href: '/owner/export', label: 'export' },
  { href: '/_emdash/admin/settings/security', label: 'account' },
];

export function AdminMenu({ pathname }: { pathname: string }) {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);

  return (
    <Menu.Root>
      <Menu.Trigger
        disabled={!hydrated}
        data-feedback-id="admin-menu"
        className="inline-flex items-center gap-2 border px-2 py-1 focus-visible:outline-2 focus-visible:outline-offset-2 data-popup-open:bg-foreground data-popup-open:text-background"
      >
        admin <span aria-hidden="true">⌄</span>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={8} align="end" className="z-50">
          <Menu.Popup
            aria-label="Admin navigation"
            data-feedback-id="admin-navigation"
            className="min-w-36 max-w-[calc(100vw-2rem)] border bg-background p-1 font-mono text-[0.7rem] leading-[1.5] font-bold tracking-[0.05em] text-foreground outline-none"
          >
            {destinations.map(({ href, label }) => (
              <Menu.LinkItem
                key={href}
                href={href}
                closeOnClick
                aria-current={
                  pathname === href ||
                  (href === '/owner' && pathname.startsWith('/owner/posts/'))
                    ? 'page'
                    : undefined
                }
                className="block px-3 py-2 no-underline outline-none aria-[current=page]:underline data-highlighted:bg-foreground data-highlighted:text-background"
              >
                {label}
              </Menu.LinkItem>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
