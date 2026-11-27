import { pageRoute, rootRoute, sheetRoute } from "../../navigation/options";
import { FoodScreen } from "./FoodScreen";
import { FoodMealScreen } from "./MealSheet";
import { FoodSavedMealsScreen } from "./SavedMealsScreen";

/** The Food tab: the day's meals, saved meals and the seven-day comparison. */
export const foodScreens = {
  Food: { screen: FoodScreen, options: rootRoute("Food") },
  FoodMeal: { screen: FoodMealScreen, options: sheetRoute("Add food", [0.75, 1]) },
  FoodSavedMeals: { screen: FoodSavedMealsScreen, options: pageRoute("Saved meals") },
};
