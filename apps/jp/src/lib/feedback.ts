import { z } from 'zod';

const configuration = z.object({
  server: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && value === url.origin;
  }, 'Use an exact HTTPS origin without a path or credentials.'),
  projectId: z.string().regex(/^prj_[a-f0-9]{16}$/),
});

export function feedbackConfiguration(server?: string, projectId?: string) {
  if (!server && !projectId) return null;
  return configuration.parse({ server, projectId });
}
