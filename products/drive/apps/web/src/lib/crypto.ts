import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const encryptionAlgorithm = "aes-256-gcm";

export function randomToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

export function hashToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function verifyPkce(verifier: string, expectedChallenge: string): boolean {
  const actual = Buffer.from(pkceChallenge(verifier));
  const expected = Buffer.from(expectedChallenge);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function seal(plaintext: string, encodedKey: string): string {
  const key = decodeEncryptionKey(encodedKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv(encryptionAlgorithm, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map((part) => part.toString("base64url")).join(".");
}

export function open(sealedValue: string, encodedKey: string): string {
  const parts = sealedValue.split(".");
  if (parts.length !== 3) {
    throw new Error("Encrypted value has an invalid format.");
  }
  const [encodedIv, encodedTag, encodedCiphertext] = parts;
  if (!encodedIv || !encodedTag || !encodedCiphertext) {
    throw new Error("Encrypted value is incomplete.");
  }

  const decipher = createDecipheriv(
    encryptionAlgorithm,
    decodeEncryptionKey(encodedKey),
    Buffer.from(encodedIv, "base64url")
  );
  decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encodedCiphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function decodeEncryptionKey(encodedKey: string): Buffer {
  const key = Buffer.from(encodedKey, "base64url");
  if (key.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be a base64url-encoded 32-byte key.");
  }
  return key;
}
