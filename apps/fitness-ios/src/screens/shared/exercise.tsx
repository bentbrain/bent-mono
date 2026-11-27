import Constants from "expo-constants";
import { Image } from "expo-image";
import { View } from "react-native";
import { exercises } from "@bent/fitness-contracts/domain";
import type { Exercise } from "@bent/fitness-contracts/domain";
import { guides } from "@bent/fitness-contracts/guides";
import { formatDuration } from "@bent/fitness-contracts/timing";
import { Symbol } from "../../ui/Symbol";
import { cn } from "../../ui/typography";

const origin = String(Constants.expoConfig?.extra?.fitnessOrigin ?? "https://fitness.bent.build").replace(/\/$/, "");

export const guideFor = (id: string) => guides.find((guide) => guide.id === id);
export const nameFor = (id: string) => exercises.find((exercise) => exercise.id === id)?.name ?? "Exercise";

/** The full illustration for a guide, served by Fitness and cached on the iPhone. */
export const guideImage = (id: string) => `${origin}/exercise-guides/${id}.png`;
/** The middle frames of the illustration, as a small picture. */
export const guideThumb = (id: string) => `${origin}/exercise-guides/thumbs/${id}.jpg`;

/** "3 × 8–12 reps each side · 2:00 rest" */
export function prescriptionText(exercise: Exercise) {
  const unit =
    exercise.mode === "seconds"
      ? exercise.side
        ? "seconds each side"
        : "seconds"
      : exercise.side
        ? "reps each side"
        : "reps";
  return `${exercise.sets} × ${exercise.min}–${exercise.max} ${unit} · ${formatDuration(exercise.rest)} rest`;
}

/** How to record the exercise, in plain words. */
export function recordingNotes(exercise: Exercise) {
  if (exercise.mode === "seconds")
    return exercise.side
      ? "Hold each side for time. Log the seconds for left and right."
      : "Hold for time. Log the seconds you held with good form.";
  return exercise.side
    ? "Weight is for one dumbbell. Log the reps for your left and right side separately."
    : "Weight is for one dumbbell. Log the reps you completed with control.";
}

/** A small illustration of an exercise, or a dumbbell when it has no guide. */
export function ExerciseThumb({ id, width = 88, className }: { id: string; width?: number; className?: string }) {
  const height = Math.round((width * 206) / 512);
  return (
    <View
      className={cn("items-center justify-center overflow-hidden rounded-[10px] bg-card-alt", className)}
      style={{ width, height, borderCurve: "continuous" }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {guideFor(id) ? (
        <Image source={{ uri: guideThumb(id) }} style={{ width, height }} contentFit="cover" cachePolicy="memory-disk" transition={150} />
      ) : (
        <Symbol name="dumbbell" size={Math.round(height * 0.5)} tintColorClassName="accent-chevron" />
      )}
    </View>
  );
}
