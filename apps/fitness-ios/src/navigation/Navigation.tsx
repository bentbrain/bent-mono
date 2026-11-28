import { DarkTheme, DefaultTheme, createNavigationContainerRef, createStaticNavigation } from "@react-navigation/native";
import type { StaticParamList } from "@react-navigation/native";
import { createNativeBottomTabNavigator } from "@react-navigation/bottom-tabs/unstable";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useColorScheme } from "react-native";
import { FitnessHealth } from "../../modules/fitness-health";
import { useAccount } from "../account/AccountProvider";
import { LaunchRouter } from "../logic/launch";
import type { LaunchTarget } from "../logic/launch";
import { screenFor } from "../logic/screens";
import type { WidgetLink } from "../logic/widget";
import { useCSSVariable } from "uniwind";
import { exerciseScreens } from "../screens/exercises";
import { foodScreens } from "../screens/food";
import { progressScreens } from "../screens/progress";
import { settingsScreens } from "../screens/settings";
import { weekScreens } from "../screens/week";
import { rootScreens } from "../screens/root";
import { takeOpenedReminder, useReminderSchedule, useReminderTaps } from "./reminders";
import { takeLaunchWidgetLink, useWidgetLinks, useWidgetSnapshot } from "./widget";

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
 * Whether a Health connection waits for consent or for the Health step. A
 * relaunch returns to that step, since the native status keeps the wait and
 * nothing syncs until the step is done.
 */
async function healthStepWaiting() {
  const step = screenFor(await FitnessHealth.getStatus());
  return step === "consent" || step === "health";
}

function openHealthStep() {
  if (navigationRef.isReady())
    navigationRef.navigate("Tabs", { screen: "SettingsTab", params: { screen: "HealthSync", initial: false } });
}

/** Opens the Week tab at a reminder's day. */
function useOpenReminder() {
  const { owner, setDate } = useAccount();
  const open = useCallback(
    (day: string) => {
      setDate(day);
      if (navigationRef.isReady()) navigationRef.navigate("Tabs", { screen: "WeekTab", params: { screen: "Week" } });
    },
    [setDate],
  );
  return useMemo(() => ({ owner, open }), [owner, open]);
}

/** Opens the Week or Food tab at the day a widget link names. */
function useOpenWidgetLink() {
  const { setDate } = useAccount();
  return useCallback(
    ({ tab, day }: WidgetLink) => {
      setDate(day);
      if (!navigationRef.isReady()) return;
      if (tab === "food") navigationRef.navigate("Tabs", { screen: "FoodTab", params: { screen: "Food" } });
      else navigationRef.navigate("Tabs", { screen: "WeekTab", params: { screen: "Week" } });
    },
    [setDate],
  );
}

/**
 * Opens the screen a launch or a tap asks for: a reminder's day, a widget
 * link, or a Health step waiting at launch. A reminder or widget tapped while
 * the app runs replaces the launch destination; before navigation is ready
 * it opens in its place.
 */
function useLaunchRouting() {
  const reminder = useOpenReminder();
  const openWidgetLink = useOpenWidgetLink();
  const [router] = useState(() => new LaunchRouter<WidgetLink>());
  const openTarget = useCallback(
    (target: LaunchTarget<WidgetLink>) => {
      if (target.kind === "reminder") reminder.open(target.day);
      else if (target.kind === "widget") openWidgetLink(target.link);
      else openHealthStep();
    },
    [reminder, openWidgetLink],
  );
  const tapped = useCallback(
    (target: LaunchTarget<WidgetLink>) => {
      if (!navigationRef.isReady()) return router.replace(target);
      router.replace();
      openTarget(target);
    },
    [router, openTarget],
  );
  useReminderTaps(
    reminder.owner,
    useCallback((day: string) => tapped({ kind: "reminder", day }), [tapped]),
  );
  useWidgetLinks(useCallback((link: WidgetLink) => tapped({ kind: "widget", link }), [tapped]));
  /** Opens the launch destination once navigation is ready. */
  return () => {
    void router
      .resolve({
        reminder: () => takeOpenedReminder(reminder.owner),
        widget: takeLaunchWidgetLink,
        health: healthStepWaiting,
      })
      .then((target) => router.openIfCurrent(target, openTarget));
  };
}

function useColor(name: string, fallback: string) {
  const value = useCSSVariable(name);
  return typeof value === "string" ? value : fallback;
}

/** The signed-in app's navigation, themed from the app's colour tokens. */
export function Navigation() {
  useConflictReview();
  useReminderSchedule();
  useWidgetSnapshot();
  const ready = useLaunchRouting();
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
