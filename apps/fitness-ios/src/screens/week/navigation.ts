import { useTabNavigation } from "../../navigation/hooks";

/** Navigation from a Week tab screen: this stack, the other tabs and the root sheets. */
export const useWeekNavigation = () => useTabNavigation<"WeekTab">();
