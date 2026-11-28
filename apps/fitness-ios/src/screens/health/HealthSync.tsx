import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, AppState, View } from "react-native";
import type { SyncStatus } from "../../../modules/fitness-health";
import { FitnessHealth } from "../../../modules/fitness-health";
import { copy } from "../../logic/copy";
import { screenFor } from "../../logic/screens";
import { EmptyState, Screen } from "../../ui/Layout";
import { Connect } from "./Connect";
import { Consent } from "./Consent";
import { HealthAccess } from "./HealthAccess";
import { Status } from "./Status";

/** The native sync service's status, kept current while the screen is open. */
function useHealthStatus() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const refresh = useCallback(() => {
    FitnessHealth.getStatus().then(setStatus, () => undefined);
  }, []);
  useEffect(() => {
    refresh();
    const subscription = FitnessHealth.addListener("onStatus", setStatus);
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    return () => {
      subscription.remove();
      appState.remove();
    };
  }, [refresh]);
  return { status, setStatus, refresh };
}

/**
 * Apple Health sync: connect, confirm what syncs, allow Health access, then
 * the sync status. Each step follows the native key state, so a relaunch
 * returns to the step it left.
 */
export function HealthSync() {
  const { status, setStatus, refresh } = useHealthStatus();
  switch (screenFor(status)) {
    case "loading":
      return (
        <View className="flex-1 items-center justify-center bg-screen">
          <ActivityIndicator />
        </View>
      );
    case "locked":
      return (
        <Screen testID="screen-locked">
          <EmptyState icon="lock.fill" title={copy.locked.title} body={copy.locked.body} />
        </Screen>
      );
    case "signIn":
      return status ? <Connect status={status} onChange={refresh} /> : null;
    case "reconnect":
      return status ? (
        <Connect status={status} onChange={refresh} title={copy.reconnect.title} body={copy.reconnect.body} />
      ) : null;
    case "consent":
      return status ? <Consent status={status} onChange={refresh} /> : null;
    case "health":
      return status ? <HealthAccess status={status} onStarted={setStatus} /> : null;
    case "status":
      return status ? <Status status={status} onChange={refresh} /> : null;
  }
}
