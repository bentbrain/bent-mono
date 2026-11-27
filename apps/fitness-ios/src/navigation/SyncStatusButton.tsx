import { useNavigation } from "@react-navigation/native";
import { ActivityIndicator, Pressable, View } from "react-native";
import { useAccount } from "../account/AccountProvider";
import type { Sync } from "../account/AccountProvider";
import { haptic } from "../ui/haptics";
import { Symbol } from "../ui/Symbol";
import type { SFSymbol } from "../ui/Symbol";
import { AppText } from "../ui/Text";
import { cn } from "../ui/typography";

type Status = { label: string; icon: SFSymbol | null; tone: "done" | "busy" | "warning" | "danger" };

/** The save state in the web header's words. */
export function syncStatus(
  sync: Pick<Sync, "online" | "saving" | "error" | "pending" | "ready" | "conflict">,
  inputPending = false,
): Status {
  if (sync.conflict) return { label: "Review conflict", icon: "exclamationmark.triangle.fill", tone: "danger" };
  if (!sync.online)
    return { label: sync.pending ? `Offline · ${sync.pending} pending` : "Offline", icon: "icloud.slash", tone: "warning" };
  if (sync.saving) return { label: "Saving…", icon: null, tone: "busy" };
  if (sync.error) return { label: "Needs attention", icon: "exclamationmark.circle.fill", tone: "danger" };
  if (inputPending) return { label: "Unsaved input on device", icon: "pencil.circle", tone: "busy" };
  if (sync.pending) return { label: `${sync.pending} pending`, icon: null, tone: "busy" };
  if (!sync.ready) return { label: "Loading…", icon: null, tone: "busy" };
  return { label: "Saved", icon: "checkmark.icloud", tone: "done" };
}

const surfaces = { done: "bg-card-alt", busy: "bg-card-alt", warning: "bg-missed-soft", danger: "bg-danger-soft" };
const tints = { done: "accent-done", busy: "accent-icon", warning: "accent-missed", danger: "accent-danger-foreground" };
const texts = { done: "muted", busy: "muted", warning: "missed", danger: "danger" } as const;

/** A small status chip in each tab's header. Tapping it opens the sync details. */
export function SyncStatusButton() {
  const { sync, inputPending } = useAccount();
  const navigation = useNavigation();
  const status = syncStatus(sync, inputPending);
  return (
    <Pressable
      testID="sync-status"
      accessibilityRole="button"
      accessibilityLabel={`Sync status: ${status.label}`}
      accessibilityHint="Shows saving details and pending changes"
      hitSlop={8}
      onPress={() => {
        haptic("selection");
        navigation.navigate("SyncDetails");
      }}
      className={cn("h-8 flex-row items-center gap-1.5 rounded-full px-3 active:opacity-70", surfaces[status.tone])}
    >
      <View className="size-3.5 items-center justify-center">
        {status.icon ? (
          <Symbol name={status.icon} size={13} weight="semibold" tintColorClassName={tints[status.tone]} />
        ) : (
          <ActivityIndicator size="small" style={{ transform: [{ scale: 0.6 }] }} />
        )}
      </View>
      <AppText textRole="caption" weight="semibold" tone={texts[status.tone]}>
        {status.label}
      </AppText>
    </Pressable>
  );
}
