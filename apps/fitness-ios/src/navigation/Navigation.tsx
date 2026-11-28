import { DarkTheme, DefaultTheme, createNavigationContainerRef, createStaticNavigation } from "@react-navigation/native";
import type { StaticParamList } from "@react-navigation/native";
import { createNativeBottomTabNavigator } from "@react-navigation/bottom-tabs/unstable";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { useCallback, useEffect, useRef } from "react";
import { useColorScheme } from "react-native";
import { FitnessHealth } from "../../modules/fitness-health";
import { useAccount } from "../account/AccountProvider";
import { screenFor } from "../logic/screens";
import { useCSSVariable } from "uniwind";
import { exerciseScreens } from "../screens/exercises";
import { foodScreens } from "../screens/food";
import { progressScreens } from "../screens/progress";
import { settingsScreens } from "../screens/settings";
import { weekScreens } from "../screens/week";
import { rootScreens } from "../screens/root";
import { takeOpenedReminder, useReminderSchedule, useReminderTaps } from "./reminders";

/*
 * The route table. Each tab has its own native stack, so pushed screens
 * keep the tab bar, as in Apple's own apps. Sheets and full-screen flows
 * that belong to no tab sit on the root stack above the tabs.
 */
const WeekStack = createNativeStackNavigator({ screens: weekScreens });
const ExercisesStack = createNativeStackNavigator({ screens: exerciseScreens });
const FoodStack = createNativeStackNavigator({ screens: foodScreens });
const ProgressStack = createNativeStackNavigator({ screens: progressScreens });
const SettingsStack = createNativeStackNavigator({ screens: settingsScreens });

const Tabs = createNativeBottomTabNavigator({
  screenOptions: { headerShown: false },
  screens: {
    WeekTab: {
      screen: WeekStack,
      options: {
        title: "Week",
        tabBarIcon: ({ focused }) => ({ type: "sfSymbol", name: focused ? "calendar.circle.fill" : "calendar.circle" }),
      },
    },
    ExercisesTab: {
      screen: ExercisesStack,
      options: {
        title: "Exercises",
        tabBarIcon: { type: "sfSymbol", name: "dumbbell" },
      },
    },
    FoodTab: {
      screen: FoodStack,
      options: {
        title: "Food",
        tabBarIcon: { type: "sfSymbol", name: "fork.knife" },
      },
    },
    ProgressTab: {
      screen: ProgressStack,
      options: {
        title: "Progress",
        tabBarIcon: { type: "sfSymbol", name: "chart.line.uptrend.xyaxis" },
      },
    },
    SettingsTab: {
      screen: SettingsStack,
      options: {
        title: "Settings",
        tabBarIcon: ({ focused }) => ({ type: "sfSymbol", name: focused ? "gearshape.fill" : "gearshape" }),
      },
    },
  },
});

const RootStack = createNativeStackNavigator({
  screens: {
    Tabs: { screen: Tabs, options: { headerShown: false } },
    ...rootScreens,
  },
});

type RootParamList = StaticParamList<typeof RootStack>;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace ReactNavigation {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface RootParamList extends StaticParamList<typeof RootStack> {}
  }
}

const StaticNavigation = createStaticNavigation(RootStack);
const navigationRef = createNavigationContainerRef<RootParamList>();

/** Opens the sync details once for each new conflict, so it is reviewed before more editing. */
function useConflictReview() {
  const { sync } = useAccount();
  const shown = useRef<string | null>(null);
  const conflict = sync.conflict ? (sync.conflict.current?.id ?? "removed") + ":" + (sync.conflict.current?.revision ?? 0) : null;
  useEffect(() => {
    if (!conflict) {
      shown.current = null;
      return;
    }
    if (shown.current === conflict || !navigationRef.isReady()) return;
    shown.current = conflict;
    navigationRef.navigate("SyncDetails");
  }, [conflict]);
}

/**
 * A Health connection waiting for consent or for the Health step opens at
 * that step, so a relaunch returns to the step it left. The native status
 * keeps the wait, and nothing syncs until the step is done.
 */
function resumeHealthStep() {
  FitnessHealth.getStatus().then(
    (status) => {
      const step = screenFor(status);
      if ((step === "consent" || step === "health") && navigationRef.isReady())
        navigationRef.navigate("Tabs", { screen: "SettingsTab", params: { screen: "HealthSync", initial: false } });
    },
    () => undefined,
  );
}

/** Opens the Week tab at a tapped reminder's day. */
function useOpenReminder() {
  const { setDate } = useAccount();
  const open = useCallback(
    (day: string) => {
      setDate(day);
      if (navigationRef.isReady()) navigationRef.navigate("Tabs", { screen: "WeekTab", params: { screen: "Week" } });
    },
    [setDate],
  );
  useReminderTaps(open);
  return open;
}

function useColor(name: string, fallback: string) {
  const value = useCSSVariable(name);
  return typeof value === "string" ? value : fallback;
}

/** The signed-in app's navigation, themed from the app's colour tokens. */
export function Navigation() {
  useConflictReview();
  useReminderSchedule();
  const openReminder = useOpenReminder();
  const ready = () => {
    resumeHealthStep();
    const day = takeOpenedReminder();
    if (day) openReminder(day);
  };
  const dark = useColorScheme() === "dark";
  const base = dark ? DarkTheme : DefaultTheme;
  const theme = {
    ...base,
    colors: {
      ...base.colors,
      primary: useColor("--color-primary", base.colors.primary),
      background: useColor("--color-screen", base.colors.background),
      card: useColor("--color-card", base.colors.card),
      text: useColor("--color-foreground", base.colors.text),
      border: useColor("--color-border", base.colors.border),
    },
  };
  return <StaticNavigation ref={navigationRef} theme={theme} onReady={ready} />;
}
