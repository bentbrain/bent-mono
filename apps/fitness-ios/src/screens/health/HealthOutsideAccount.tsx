import { useEffect, useRef, useState } from "react";
import { Modal, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { SyncStatus } from "../../../modules/fitness-health";
import { FitnessHealth } from "../../../modules/fitness-health";
import { screenFor } from "../../logic/screens";
import { IconButton } from "../../ui/Button";
import { ListRow, ListSection } from "../../ui/List";
import { AppText } from "../../ui/Text";
import { HealthSync } from "./HealthSync";

/**
 * Apple Health sync for an iPhone that holds a device key while the Fitness
 * account isn't open, such as after signing out. The key keeps syncing on
 * its own, so its consent, Health step, status and Disconnect stay here. A
 * pending consent or Health step opens at once, as after a relaunch.
 */
export function HealthOutsideAccount() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [open, setOpen] = useState(false);
  const resumed = useRef(false);
  useEffect(() => {
    let active = true;
    const read = () =>
      FitnessHealth.getStatus().then(
        (next) => {
          if (active) setStatus(next);
        },
        () => undefined,
      );
    void read();
    const subscription = FitnessHealth.addListener("onStatus", (next) => setStatus(next));
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);
  useEffect(() => {
    const step = screenFor(status);
    if (!resumed.current && (step === "consent" || step === "health")) {
      resumed.current = true;
      setOpen(true);
    }
  }, [status]);

  // A disconnected iPhone still shows keys to revoke by hand until dismissed.
  if (!status || (status.state === "signedOut" && !status.manualRevocations)) return null;
  return (
    <>
      <ListSection>
        <ListRow
          icon="heart.fill"
          iconTile="bg-missed"
          label="Apple Health sync"
          description={
            status.state === "active"
              ? "Connected on this iPhone"
              : status.state === "signedOut"
                ? "Keys to revoke in Fitness"
                : "Waiting for you on this iPhone"
          }
          navigates
          onPress={() => setOpen(true)}
          testID="open-health-outside"
        />
      </ListSection>
      <Modal visible={open} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setOpen(false)}>
        <SafeAreaView className="flex-1 bg-screen" edges={["top"]}>
          <View className="flex-row items-center justify-between px-4 py-2">
            <AppText textRole="headline" weight="bold" accessibilityRole="header">
              Apple Health
            </AppText>
            <IconButton icon="xmark" label="Close" tone="secondary" size={34} onPress={() => setOpen(false)} testID="close-health-outside" />
          </View>
          <HealthSync />
        </SafeAreaView>
      </Modal>
    </>
  );
}
