import { pageRoute, rootRoute } from "../../navigation/options";
import { ExerciseScreen } from "./ExerciseScreen";
import { ExercisesScreen } from "./ExercisesScreen";

/** The Exercises tab: the guide list and each exercise's guide. */
export const exerciseScreens = {
  Exercises: { screen: ExercisesScreen, options: rootRoute("Exercises") },
  Exercise: { screen: ExerciseScreen, options: pageRoute("Exercise") },
};
