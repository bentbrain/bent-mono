import { Text, View } from "react-native";
import { FitnessHealth } from "../modules/fitness-health";

export default function App() {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
      <Text>Fitness Sync</Text>
      <Text>{FitnessHealth.healthDataAvailable() ? "Health data is available." : "Health data is unavailable."}</Text>
    </View>
  );
}
