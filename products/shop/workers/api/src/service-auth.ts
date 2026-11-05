import { timingSafeEqual } from "node:crypto";

interface ServiceAuthEnv {
  readonly FOREVER_TEE_API_SHARED_SECRET?: string;
}

interface OperationsAuthEnv {
  readonly BENT_SHIRT_OPERATIONS_SECRET?: string;
}

export async function isAuthenticatedServiceRequest(
  request: Request,
  env: ServiceAuthEnv,
) {
  return secretsMatch(
    env.FOREVER_TEE_API_SHARED_SECRET,
    request.headers.get("x-forever-tee-service-secret"),
  );
}

export async function isAuthenticatedOperationsRequest(
  request: Request,
  env: OperationsAuthEnv,
) {
  return secretsMatch(
    env.BENT_SHIRT_OPERATIONS_SECRET,
    request.headers.get("x-bent-shirt-operations-secret"),
  );
}

async function secretsMatch(
  expected: string | undefined,
  provided: string | null,
) {
  if (!expected || !provided) return false;

  const encoder = new TextEncoder();
  const [expectedHash, providedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
  ]);
  return timingSafeEqual(
    new Uint8Array(expectedHash),
    new Uint8Array(providedHash),
  );
}
