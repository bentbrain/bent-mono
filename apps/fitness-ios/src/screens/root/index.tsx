import { sheetRoute } from "../../navigation/options";
import { ExerciseGuide } from "./ExerciseGuide";
import { SyncDetails } from "./SyncDetails";

/** Sheets above the tabs, opened from any tab. */
export const rootScreens = {
  ExerciseGuide: { screen: ExerciseGuide, options: sheetRoute("Exercise guide", [0.75, 1]) },
  SyncDetails: { screen: SyncDetails, options: sheetRoute("Saving", [0.6, 1]) },
};
