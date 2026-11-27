import { pageRoute, rootRoute } from "../../navigation/options";
import { BodyScreen } from "./BodyScreen";
import { CorrectionScreen } from "./CorrectionScreen";
import { HistoryScreen } from "./HistoryScreen";
import { ProgressScreen } from "./ProgressScreen";

/** The Progress tab: summaries, workout history and bodyweight. */
export const progressScreens = {
  Progress: { screen: ProgressScreen, options: rootRoute("Progress") },
  History: { screen: HistoryScreen, options: pageRoute("History") },
  HistoryCorrection: { screen: CorrectionScreen, options: pageRoute("Correct results") },
  Body: { screen: BodyScreen, options: pageRoute("Bodyweight") },
};
