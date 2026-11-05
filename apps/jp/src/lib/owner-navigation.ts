// Match the existing server policy: production requires the configured sole
// owner email as well as an administrator role. Development uses local emDash auth.
export function showOwnerNavigation(
  user: { email: string; role: number } | null | undefined,
  ownerEmail: string | undefined,
  development: boolean,
): boolean {
  return Boolean(
    user &&
    user.role >= 50 &&
    (development || (ownerEmail && user.email === ownerEmail)),
  );
}
