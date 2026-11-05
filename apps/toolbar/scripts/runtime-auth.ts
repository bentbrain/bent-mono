import { z } from 'zod';

const names = [
  'FEEDBACK_PROXY_SECRET',
  'BETTER_AUTH_SECRET',
  'AUTH_GITHUB_CLIENT_ID',
  'AUTH_GITHUB_CLIENT_SECRET',
];
const configurationSchema = z.object({
  FEEDBACK_PROXY_SECRET: z.string().min(32),
  BETTER_AUTH_SECRET: z.string().min(32),
  AUTH_GITHUB_CLIENT_ID: z.string().min(1),
  AUTH_GITHUB_CLIENT_SECRET: z.string().min(1),
});

export function validateRuntimeAuthInput(environment: NodeJS.ProcessEnv) {
  const preserve = environment.TOOLBAR_PRESERVE_RUNTIME_SECRETS;
  if (preserve !== undefined && preserve !== '' && !['true', 'false'].includes(preserve))
    throw new Error('TOOLBAR_PRESERVE_RUNTIME_SECRETS must be true or false.');
  if (preserve === 'true') {
    z.string().min(32).parse(environment.FEEDBACK_PROXY_SECRET);
    return;
  }
  if (!configurationSchema.safeParse(environment).success)
    throw new Error('Configure all maintained authentication secrets before deploying.');
}

export async function maintainRuntimeAuth(
  environment: NodeJS.ProcessEnv,
  operations: {
    qualify: () => Promise<unknown>;
    list: () => Promise<unknown>;
    verifyProxy: (secret: string) => Promise<unknown>;
    write: (configuration: z.infer<typeof configurationSchema>) => Promise<void>;
  },
  options: { checkOnly?: boolean } = {},
) {
  validateRuntimeAuthInput(environment);
  const preserve = environment.TOOLBAR_PRESERVE_RUNTIME_SECRETS;
  await operations.qualify();
  if (preserve === 'true') {
    const bindings = z
      .array(z.object({ name: z.string(), type: z.literal('secret_text') }))
      .parse(await operations.list());
    const present = new Set(bindings.map((binding) => binding.name));
    if (present.size !== bindings.length || names.some((name) => !present.has(name)))
      throw new Error('The existing Worker is missing required authentication secrets.');
    // The Vercel handoff must match the preserved Worker key, not merely exist.
    const proxy = z.string().min(32).parse(environment.FEEDBACK_PROXY_SECRET);
    await operations.verifyProxy(proxy);
    return;
  }
  const configuration = configurationSchema.safeParse(environment);
  if (!configuration.success)
    throw new Error('Configure all maintained authentication secrets before deploying.');
  if (options.checkOnly) return;
  await operations.qualify();
  await operations.write(configuration.data);
}
