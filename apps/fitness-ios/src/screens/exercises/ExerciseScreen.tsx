import { useLayoutEffect } from "react";
import { useNavigation } from "@react-navigation/native";
import type { StaticScreenProps } from "@react-navigation/native";
import { Screen } from "../../ui/Layout";
import { nameFor } from "../shared/exercise";
import { GuideContent } from "./GuideContent";

/** One exercise's full guide, opened from the Exercises list or a guide sheet. */
export function ExerciseScreen({ route }: StaticScreenProps<{ id: string }>) {
  const { id } = route.params;
  const navigation = useNavigation();
  useLayoutEffect(() => {
    navigation.setOptions({ title: nameFor(id) });
  }, [id, navigation]);
  return (
    <Screen testID="exercise-screen">
      <GuideContent id={id} />
    </Screen>
  );
}
