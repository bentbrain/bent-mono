import { pageRoute, rootRoute } from "../../navigation/options";
import { HealthSync } from "../health/HealthSync";
import { EquipmentScreen } from "./EquipmentScreen";
import { PlanSettingsScreen } from "./PlanSettingsScreen";
import { ProfileScreen } from "./ProfileScreen";
import { RemindersScreen } from "./RemindersScreen";
import { SettingsScreen } from "./SettingsScreen";

/** The Settings tab: profile, plan, equipment, reminders, Apple Health and the account. */
export const settingsScreens = {
  Settings: { screen: SettingsScreen, options: rootRoute("Settings") },
  Profile: { screen: ProfileScreen, options: pageRoute("Profile and targets") },
  PlanSettings: { screen: PlanSettingsScreen, options: pageRoute("Repeating week") },
  Equipment: { screen: EquipmentScreen, options: pageRoute("Equipment and photos") },
  Reminders: { screen: RemindersScreen, options: pageRoute("Reminders") },
  HealthSync: { screen: HealthSync, options: pageRoute("Apple Health") },
};
