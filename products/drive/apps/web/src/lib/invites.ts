import { z } from "zod";

import { normalizeGithubUsername } from "./identity";

const githubUsernameSchema = z
  .string()
  .trim()
  .transform(normalizeGithubUsername)
  .pipe(
    z
      .string()
      .min(1)
      .max(39)
      .regex(/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/)
      .refine((username) => !username.includes("--"), "GitHub usernames cannot contain --.")
  );

export const createInviteInputSchema = z.object({
  githubUsername: githubUsernameSchema,
  expiresInDays: z.coerce.number().int().min(1).max(365),
});

export const inviteIdSchema = z.string().uuid();
