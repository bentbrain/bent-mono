import { View } from "react-native";
import { AppText } from "../../ui/Text";

/**
 * A label and value row for Health sync details. The test ID and exact value
 * sit on the value, so the Simulator flows read them.
 */
export function ValueRow({ label, value, testID, exact }: { label: string; value: string; testID?: string; exact?: string }) {
  return (
    <View className="min-h-12 flex-row items-center justify-between gap-3 px-4 py-3">
      <AppText>{label}</AppText>
      <AppText
        tone="muted"
        testID={testID}
        accessibilityValue={exact === undefined ? undefined : { text: exact }}
        className="max-w-[60%] shrink text-right"
      >
        {value}
      </AppText>
    </View>
  );
}
