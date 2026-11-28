import { useEffect, useState } from "react";
import { Keyboard, View } from "react-native";
import { Button } from "./Button";
import { useNumberPadFocused } from "./numberPad";

/** The Done bar, drawn once above the app and shown over number pads. */
export function KeyboardDoneBar() {
  const wanted = useNumberPadFocused();
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const show = Keyboard.addListener("keyboardWillShow", (event) => setHeight(event.endCoordinates.height));
    const change = Keyboard.addListener("keyboardWillChangeFrame", (event) => setHeight(event.endCoordinates.height));
    const hide = Keyboard.addListener("keyboardWillHide", () => setHeight(0));
    return () => {
      show.remove();
      change.remove();
      hide.remove();
    };
  }, []);
  if (!wanted || height === 0) return null;
  return (
    <View
      className="absolute inset-x-0 flex-row justify-end border-t border-border bg-card-alt px-3 py-1.5"
      style={{ bottom: height }}
      testID="keyboard-done-bar"
    >
      <Button
        label="Done"
        tone="plain"
        size="compact"
        accessibilityLabel="Close keyboard"
        onPress={() => Keyboard.dismiss()}
      />
    </View>
  );
}
