import { resolvePluginEncryptionKeys } from 'emdash';
import { z } from 'zod';

const purpose = 'jp.bent.build:saved-post-image-recovery:v1';
const bindingSchema = z.strictObject({
  origin: z.url().max(2048),
  postId: z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
  createdAt: z.string().min(1).max(128),
  principalId: z.string().min(1).max(2048),
  source: z.url().max(8192),
});
export type SavedImageBinding = z.infer<typeof bindingSchema>;
export const savedImageProof = z
  .string()
  .length(55)
  .regex(/^v1\.[a-f0-9]{8}\.[A-Za-z0-9_-]{43}$/);

function message(binding: SavedImageBinding) {
  const value = bindingSchema.parse(binding);
  return new TextEncoder().encode(
    JSON.stringify([
      purpose,
      value.origin,
      'posts',
      value.postId,
      value.createdAt,
      value.principalId,
      value.source,
    ]),
  );
}

function encode(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

// Use the public native resolver for the already-required deployment key.
// Derive a separate HMAC key; neither encryption nor preview tokens are proofs.
export async function savedImageRecovery(secret: string | undefined) {
  const keys = await resolvePluginEncryptionKeys({
    EMDASH_ENCRYPTION_KEY: secret,
  });
  if (!keys?.length)
    throw new Error('Image recovery authorization unavailable');
  const derived = await Promise.all(
    keys.map(async ({ kid, key }) => {
      const material = await crypto.subtle.importKey(
        'raw',
        new Uint8Array(key),
        'HKDF',
        false,
        ['deriveKey'],
      );
      const signingKey = await crypto.subtle.deriveKey(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: new TextEncoder().encode(purpose),
          info: new TextEncoder().encode('saved-reference authorization'),
        },
        material,
        { name: 'HMAC', hash: 'SHA-256', length: 256 },
        false,
        ['sign', 'verify'],
      );
      return { kid, signingKey };
    }),
  );
  const primary = derived[0];
  if (!primary) throw new Error('Image recovery authorization unavailable');
  return {
    async sign(binding: SavedImageBinding) {
      const signature = await crypto.subtle.sign(
        'HMAC',
        primary.signingKey,
        message(binding),
      );
      return `v1.${primary.kid}.${encode(new Uint8Array(signature))}`;
    },
    async verify(proof: string, binding: SavedImageBinding) {
      if (!savedImageProof.safeParse(proof).success) return false;
      const [, kid, signature] = proof.split('.');
      const key = derived.find((key) => key.kid === kid);
      if (!key || !signature) return false;
      const bytes = Uint8Array.from(
        atob(signature.replaceAll('-', '+').replaceAll('_', '/')),
        (character) => character.charCodeAt(0),
      );
      if (encode(bytes) !== signature) return false;
      return crypto.subtle.verify(
        'HMAC',
        key.signingKey,
        bytes,
        message(binding),
      );
    },
  };
}

// Only callers holding actual server-read saved content may issue these proofs.
// No expiry: active Undo can outlive any revision retention or session refresh.
// Authentication, current revision and post existence are checked on every use.
export async function savedImageProofs(
  sources: string[],
  binding: Omit<SavedImageBinding, 'source'>,
  secret: string | undefined,
) {
  if (!sources.length) return {};
  const recovery = await savedImageRecovery(secret);
  return Object.fromEntries(
    await Promise.all(
      sources.map(async (source): Promise<[string, string]> => [
        source,
        await recovery.sign({ ...binding, source }),
      ]),
    ),
  );
}
