/** The device reply's promise: one outcome per submitted (ref, type). */
import { DeviceOutcome, canonicalRef } from "@bent/fitness-contracts";
import type { DeviceReply } from "@bent/fitness-contracts";

/** The reply would not give each submitted ref exactly one outcome. */
export class DeviceReplyMismatch extends Error {}

/**
 * Checks that a device reply has exactly one valid outcome for each
 * submitted (ref, type), and no others. Refs compare in canonical form.
 */
export function checkDeviceReply(
  submitted: { ref: string; type: string }[],
  reply: DeviceReply,
) {
  const key = (o: { ref: string; type: string }) =>
    `${o.type} ${canonicalRef(o.ref) ?? o.ref}`;
  const expected = new Map<string, number>();
  for (const entry of submitted)
    expected.set(key(entry), (expected.get(key(entry)) ?? 0) + 1);
  if ([...expected.values()].some((n) => n !== 1))
    throw new DeviceReplyMismatch("A ref was submitted more than once.");
  if (reply.outcomes.length !== submitted.length)
    throw new DeviceReplyMismatch("The reply has a different outcome count.");
  for (const outcome of reply.outcomes) {
    if (!DeviceOutcome.safeParse(outcome).success)
      throw new DeviceReplyMismatch("An outcome is not valid.");
    if (!expected.delete(key(outcome)))
      throw new DeviceReplyMismatch("An outcome has no matching ref.");
  }
  if (expected.size) throw new DeviceReplyMismatch("A ref has no outcome.");
}
