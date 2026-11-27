import { useTabNavigation } from "../../navigation/hooks";

/** Navigation from a Food tab screen: this stack, the other tabs and the root sheets. */
export const useFoodNavigation = () => useTabNavigation<"FoodTab">();
