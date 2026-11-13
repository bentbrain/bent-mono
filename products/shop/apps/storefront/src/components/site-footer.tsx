const policyLinks = [
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: "/shipping", label: "Shipping" },
  { href: "/returns", label: "Returns" },
  { href: "/content-rules", label: "Content rules" },
  { href: "/contact", label: "Contact" },
];

export function SiteFooter() {
  return (
    <footer className="border-t border-primary bg-background px-[clamp(1rem,4vw,4rem)] py-6 text-primary">
      <nav aria-label="Policies and contact">
        <ul className="flex flex-wrap gap-x-6 gap-y-3 text-[0.68rem] font-bold tracking-[0.05em]">
          {policyLinks.map((link) => (
            <li key={link.href}>
              <a
                className="underline-offset-4 hover:underline"
                href={link.href}
              >
                {link.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </footer>
  );
}
