import { describe, expect, it, vi } from 'vitest';
import { admittedNativeV5Target, parseNativeV5Target } from './native-v5-target';
import { invokeQualifiedNativeV5 } from './story-video-lambda';

const common = { environment: 'qualification', functionArn: 'arn:aws:lambda:ap-southeast-2:123456789012:function:qualification-native:7',
  codeDigest: 'a'.repeat(64), inputsDigest: 'b'.repeat(64), grantKeyId: 'bootstrap-fixture-key' };

describe('retained bootstrap targets', () => {
  it('distinguishes prior qualification from authority to qualify a numbered candidate', () => {
    const qualified = { ...common, schemaVersion: 1, qualificationDigest: 'c'.repeat(64) };
    const bootstrap = { ...common, schemaVersion: 2, bootstrapAuthorityDigest: 'd'.repeat(64) };
    expect(parseNativeV5Target(JSON.stringify(qualified))).toEqual(qualified);
    expect(parseNativeV5Target(JSON.stringify(bootstrap))).toEqual(bootstrap);
    for (const invalid of [{ ...bootstrap, qualificationDigest: 'e'.repeat(64) },
      { ...qualified, schemaVersion: 2 }, { ...bootstrap, schemaVersion: 1 },
      { ...bootstrap, bootstrapAuthorityDigest: 'unknown' }, { ...bootstrap, functionArn: common.functionArn.replace(':7', ':current') }])
      expect(() => parseNativeV5Target(JSON.stringify(invalid))).toThrow();
    expect(() => parseNativeV5Target(JSON.stringify(bootstrap).slice(0, -1) + ',"schemaVersion":2}')).toThrow('unique');
  });

  it('keeps bootstrap targets out of normal dispatch and credential use', async () => {
    const target = parseNativeV5Target(JSON.stringify({ ...common, schemaVersion: 2, bootstrapAuthorityDigest: 'd'.repeat(64) }));
    await expect(admittedNativeV5Target({ SHOP_NATIVE_V5_TARGET_JSON: JSON.stringify(target) })).rejects.toThrow('normal native dispatcher');
    const send = vi.fn<typeof fetch>();
    await expect(invokeQualifiedNativeV5({}, target, '{}', send)).rejects.toThrow('separately admitted credential owner');
    expect(send).not.toHaveBeenCalled();
  });
});
