import type { NativeStackNavigationOptions } from "@react-navigation/native-stack";
import { createElement } from "react";
import { liquidGlass } from "../ui/glass";
import { SyncStatusButton } from "./SyncStatusButton";

/**
 * iOS 26 draws its own scroll edge effect under transparent headers. Earlier
 * versions need a blurred header so content stays legible beneath it.
 */
const headerBackground: NativeStackNavigationOptions = liquidGlass ? {} : { headerBlurEffect: "systemChromeMaterial" };

/**
 * Header presets. Screens choose one of these rather than setting
 * presentation options themselves.
 */

/**
 * A tab's root screen: a large title that collapses as the content
 * scrolls, with the sync status on the left.
 */
export function rootRoute(title: string): NativeStackNavigationOptions {
  return {
    title,
    headerLeft: () => createElement(SyncStatusButton),
    headerLargeTitle: true,
    headerLargeTitleShadowVisible: false,
    headerShadowVisible: false,
    headerTransparent: true,
    ...headerBackground,
    headerLargeStyle: { backgroundColor: "transparent" },
  };
}

/** A pushed screen with a standard title. */
export function pageRoute(title: string): NativeStackNavigationOptions {
  return {
    title,
    headerLargeTitle: false,
    headerShadowVisible: false,
    headerTransparent: true,
    ...headerBackground,
    headerBackButtonDisplayMode: "minimal",
  };
}

/** A sheet that rises from the bottom, with a grabber and the given heights. */
export function sheetRoute(title: string, detents: number[] = [0.6, 1]): NativeStackNavigationOptions {
  return {
    title,
    presentation: "formSheet",
    sheetGrabberVisible: true,
    sheetAllowedDetents: detents,
    sheetCornerRadius: 24,
    headerShown: true,
    headerTransparent: false,
    headerShadowVisible: false,
    contentStyle: { flex: 1 },
  };
}
