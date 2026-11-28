import { Pressable, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { Exercise } from "@bent/fitness-contracts/domain";
import { useAccount } from "../../account/AccountProvider";
import { haptic } from "../../ui/haptics";
import { Badge, Screen } from "../../ui/Layout";
import { ListSection } from "../../ui/List";
import { Symbol } from "../../ui/Symbol";
import { AppText } from "../../ui/Text";
import { ExerciseThumb, prescriptionText } from "../shared/exercise";
import { exerciseTags, libraryOrder, measuredExercise, routinesText, routinesWith } from "./library";

/** The exercise library: exercises in the user's routines first, then the rest. */
export function ExercisesScreen() {
  const { settings } = useAccount();
  const routines = settings?.routines ?? [];
  const library = libraryOrder(routines);
  const planned = library.filter((exercise) => routinesWith(routines, exercise.id).length);
  const others = library.filter((exercise) => !routinesWith(routines, exercise.id).length);
  return (
    <Screen testID="exercises-screen">
      <AppText tone="secondary" className="px-1">
        Read the setup, practise with a light weight, then watch the tutorial. Each guide shows the movement from two
        angles.
      </AppText>
      {planned.length ? (
        <ListSection title="In your routines" testID="exercises-planned">
          {planned.map((exercise) => (
            <ExerciseRow key={exercise.id} exercise={exercise} />
          ))}
        </ListSection>
      ) : null}
      {others.length ? (
        <ListSection
          title={planned.length ? "More exercises" : "All exercises"}
          footer="Add an exercise to a routine from Repeating week in Settings."
          testID="exercises-more"
        >
          {others.map((exercise) => (
            <ExerciseRow key={exercise.id} exercise={exercise} />
          ))}
        </ListSection>
      ) : null}
    </Screen>
  );
}

/** One exercise: its picture, name, how it is measured, your prescription and routines. */
function ExerciseRow({ exercise }: { exercise: Exercise }) {
  const { settings } = useAccount();
  const navigation = useNavigation();
  const routines = settings?.routines ?? [];
  const names = routinesWith(routines, exercise.id);
  const tags = exerciseTags(exercise);
  const measured = measuredExercise(routines, exercise.id);
  const prescription = names.length && measured ? prescriptionText(measured) : null;
  const where = routinesText(names);
  return (
    <Pressable
      testID={`exercise-row-${exercise.id}`}
      accessibilityRole="button"
      accessibilityLabel={[exercise.name, tags.join(", "), prescription, where].filter(Boolean).join(". ")}
      accessibilityHint="Opens the exercise guide"
      onPress={() => {
        haptic("selection");
        navigation.navigate("Tabs", {
          screen: "ExercisesTab",
          params: { screen: "Exercise", params: { id: exercise.id } },
        });
      }}
      className="active:bg-card-alt"
    >
      <View className="flex-row items-center gap-3 px-4 py-3">
        <ExerciseThumb id={exercise.id} width={104} />
        <View className="min-w-0 flex-1 gap-1.5">
          <AppText weight="semibold">{exercise.name}</AppText>
          <View className="flex-row flex-wrap gap-1.5">
            {tags.map((tag) => (
              <Badge key={tag} label={tag} />
            ))}
          </View>
          {prescription ? (
            <AppText textRole="footnote" tone="secondary" style={{ fontVariant: ["tabular-nums"] }}>
              {prescription}
            </AppText>
          ) : null}
          <AppText textRole="caption" tone="muted">
            {where}
          </AppText>
        </View>
        <Symbol name="chevron.right" size={13} weight="semibold" tintColorClassName="accent-chevron" />
      </View>
    </Pressable>
  );
}
