import { useLayoutEffect } from "react";
import { useNavigation } from "@react-navigation/native";
import type { StaticScreenProps } from "@react-navigation/native";
import { Button, IconButton } from "../../ui/Button";
import { Screen } from "../../ui/Layout";
import { GuideContent } from "../exercises/GuideContent";
import { nameFor } from "../shared/exercise";

/**
 * Quick help for one exercise, over the current screen. Closing it leaves
 * the screen underneath as it was.
 */
export function ExerciseGuide({ route }: StaticScreenProps<{ id: string }>) {
  const { id } = route.params;
  const navigation = useNavigation();
  useLayoutEffect(() => {
    navigation.setOptions({
      title: nameFor(id),
      headerRight: () => (
        <IconButton icon="xmark" label="Close guide" tone="secondary" size={32} onPress={() => navigation.goBack()} testID="exercise-guide-close" />
      ),
    });
  }, [id, navigation]);
  return (
    <Screen testID="exercise-guide-sheet" className="gap-5">
      <GuideContent id={id} compact />
      <Button
        label="Open in Exercises"
        tone="tinted"
        icon="dumbbell"
        fullWidth
        testID="exercise-guide-open"
        onPress={() => navigation.navigate("Tabs", { screen: "ExercisesTab", params: { screen: "Exercise", params: { id } } })}
      />
    </Screen>
  );
}
