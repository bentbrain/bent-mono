import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The required fitness-ios-native context passes when the scope selected the
// native suite and it passed, or when the scope left it out and it was skipped.
export function requireIosNative(environment) {
  const { SCOPE_RESULT, IOS_NATIVE, SUITE_RESULT } = environment;
  if (SCOPE_RESULT !== "success")
    throw new Error(`CI scope selection ended with ${SCOPE_RESULT}.`);
  if (IOS_NATIVE === "false" && SUITE_RESULT === "skipped")
    return "The native iPhone suite is not selected for this change.";
  if (IOS_NATIVE === "true" && SUITE_RESULT === "success")
    return "The native iPhone suite passed.";
  throw new Error(
    `Native iPhone validation incomplete (selected=${IOS_NATIVE}, suite=${SUITE_RESULT}).`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  console.log(requireIosNative(process.env));
}
