import * as Haptics from "expo-haptics";

/** Fire-and-forget haptic feedback. */
export function haptic(kind: "selection" | "light" | "medium" | "success" | "warning" | "error") {
  const done = () => undefined;
  switch (kind) {
    case "selection":
      return void Haptics.selectionAsync().catch(done);
    case "light":
      return void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(done);
    case "medium":
      return void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(done);
    case "success":
      return void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(done);
    case "warning":
      return void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(done);
    case "error":
      return void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(done);
  }
}
