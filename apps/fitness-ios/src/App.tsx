import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, AppState, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import type { SyncStatus } from "../modules/fitness-health";
import { FitnessHealth } from "../modules/fitness-health";
import { copy } from "./logic/copy";
import { screenFor } from "./logic/screens";
import { Consent } from "./screens/Consent";
import { Health } from "./screens/Health";
import { SignIn } from "./screens/SignIn";
import { Status } from "./screens/Status";
import { useTheme } from "./ui/theme";

export default function App() {
  return (
    <SafeAreaProvider>
      <Root />
    </SafeAreaProvider>
  );
}

function Root() {
  const theme = useTheme();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [healthStepDone, setHealthStepDone] = useState(false);

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

  switch (screenFor(status, healthStepDone)) {
    case "loading":
      return (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: theme.background }}>
          <ActivityIndicator />
        </View>
      );
    case "signIn":
      return <SignIn onChange={refresh} />;
    case "reconnect":
      return <SignIn onChange={refresh} title={copy.reconnect.title} body={copy.reconnect.body} />;
    case "consent":
      return status ? <Consent status={status} onChange={refresh} /> : null;
    case "health":
      return status ? (
        <Health
          status={status}
          onStarted={() => {
            setHealthStepDone(true);
            refresh();
          }}
        />
      ) : null;
    case "status":
      return status ? <Status status={status} onChange={refresh} /> : null;
  }
}
