import { z } from 'zod';
import { categoryNames } from './category-icons';
import {
  ownerIconProviderStatus,
  ownerIconStatuses,
  resumeIconProvider,
  retryCategoryIcon,
} from './category-icon-jobs';
import type { IconEnvironment } from './category-icon-jobs';

// These responses are called only behind the existing sole-owner middleware.
export async function categoryIconStatusResponse(
  env: IconEnvironment,
  names: string[],
) {
  return Response.json({ icons: await ownerIconStatuses(env, names) });
}
export async function categoryIconRetryResponse(
  env: IconEnvironment,
  request: Request,
  savedNames: () => Promise<string[]>,
) {
  const body = z
    .object({
      category: z.string().min(1).max(40),
      acknowledgeCharge: z.boolean().default(false),
    })
    .safeParse(await request.json().catch(() => null));
  if (!body.success)
    return Response.json({ error: 'Choose a saved category' }, { status: 400 });
  const selected = categoryNames([body.data.category])[0];
  if (
    !selected ||
    !categoryNames(await savedNames()).some(
      (name) => name.normalized === selected.normalized,
    )
  )
    return Response.json({ error: 'Choose a saved category' }, { status: 404 });
  return (await retryCategoryIcon(
    env,
    selected.label,
    body.data.acknowledgeCharge,
  ))
    ? Response.json({ queued: true })
    : Response.json(
        {
          error:
            'Icon retry unavailable. Check setup, pending work or generation limit.',
        },
        { status: 409 },
      );
}
export async function iconProviderStatusResponse(env: IconEnvironment) {
  return Response.json(await ownerIconProviderStatus(env));
}
export async function iconProviderResumeResponse(
  env: IconEnvironment,
  request: Request,
) {
  const body = z
    .object({ action: z.literal('resume') })
    .strict()
    .safeParse(await request.json().catch(() => null));
  if (!body.success)
    return Response.json(
      { error: 'Choose resume to allow queued icons to generate' },
      { status: 400 },
    );
  return (await resumeIconProvider(env))
    ? Response.json({ resumed: true })
    : Response.json(
        {
          error:
            'Configure the image service or refresh its status before resuming.',
        },
        { status: 409 },
      );
}
