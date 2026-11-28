import Constants from "expo-constants";
import { WorkoutWidget } from "../../modules/workout-activity";
import { WidgetPublisher } from "../logic/widget";

/*
 * The Today widget's snapshot on this iPhone: the publisher that writes it
 * to the App Group container the widget extension reads.
 */

const native = WorkoutWidget;

/** The one widget publisher for this app process. Without the native module, as in unit tests, it writes nothing. */
export const widget = new WidgetPublisher(native ? { save: (json) => native.save(json) } : null);

const scheme = Constants.expoConfig?.scheme;
/** The app's URL scheme, which the widget's links use. */
export const appScheme = (Array.isArray(scheme) ? scheme[0] : scheme) ?? "build.bent.fitness";
