export function configurationReady() {
  return Boolean(
    process.env.DATABASE_URL &&
    process.env.CLERK_SECRET_KEY &&
    process.env.VITE_CLERK_PUBLISHABLE_KEY &&
    process.env.FITNESS_ALLOWED_EMAILS?.trim(),
  );
}
export function allowedEmails() {
  return new Set(
    (process.env.FITNESS_ALLOWED_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}
