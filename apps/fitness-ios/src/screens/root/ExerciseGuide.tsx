import { useLayoutEffect } from "react";
import { useNavigation } from "@react-navigation/native";
import type { StaticScreenProps } from "@react-navigation/native";
import { Button, HeaderIconButton } from "../../ui/Button";
import { Screen } from "../../ui/Layout";
import type { Exercise } from "@bent/fitness-contracts/domain";
import { GuideContent } from "../exercises/GuideContent";
import { guideFor, nameFor } from "../shared/exercise";

/**
 * Quick help for one exercise, over the current screen. Closing it leaves
 * the screen underneath as it was.
 */
export function ExerciseGuide({ route }: StaticScreenProps<{ id: string; prescription?: Exercise }>) {
  const { id, prescription } = route.params;
  const navigation = useNavigation();
  useLayoutEffect(() => {
    navigation.setOptions({
      title: guideFor(id) ? nameFor(id) : (prescription?.name ?? nameFor(id)),
      headerRight: () => (
        <HeaderIconButton
          icon="xmark"
          label="Close guide"
          onPress={() => navigation.goBack()}
          testID="exercise-guide-close"
        />
      ),
    });
  }, [id, navigation, prescription?.name]);
  return (
    <Screen testID="exercise-guide-sheet" className="gap-5">
      <GuideContent id={id} prescription={prescription} compact />
      {/* Only catalogue exercises have a page in Exercises. */}
      {guideFor(id) ? (
        <Button
          label="Open in Exercises"
          tone="tinted"
          icon="dumbbell"
          fullWidth
          testID="exercise-guide-open"
          onPress={() =>
            navigation.navigate("Tabs", { screen: "ExercisesTab", params: { screen: "Exercise", params: { id } } })
          }
        />
      ) : null}
    </Screen>
  );
}
