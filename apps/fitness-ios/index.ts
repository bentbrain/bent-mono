import { randomUUID } from "expo-crypto";
import { registerRootComponent } from "expo";
import { LogBox } from "react-native";
import App from "./src/App";

// Hermes has no crypto.randomUUID; the shared Fitness rules use it for new IDs.
if (typeof globalThis.crypto?.randomUUID !== "function") {
  if (globalThis.crypto) Object.defineProperty(globalThis.crypto, "randomUUID", { value: randomUUID });
  else Object.defineProperty(globalThis, "crypto", { value: { randomUUID } });
}

// React Native warns about this in development when native header and tab
// animations send values before a listener attaches; it changes nothing.
LogBox.ignoreLogs(["Sending `onAnimatedValueUpdate` with no listeners registered."]);

registerRootComponent(App);
