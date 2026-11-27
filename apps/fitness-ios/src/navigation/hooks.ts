import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";

/**
 * The param list behind a nested navigator's params. Reads the route names
 * from the `{ screen, params }` members, which TypeScript resolves where
 * inferring through `NavigatorScreenParams` gives `any`.
 */
type ParamsOf<T> = {
  [Entry in Extract<NonNullable<T>, { screen: string; params?: unknown }> as Entry["screen"]]: Entry["params"];
};
// A mapped copy, so the interface satisfies React Navigation's index signature.
type RootParams = { [Name in keyof ReactNavigation.RootParamList]: ReactNavigation.RootParamList[Name] };
/** The tabs and the params each tab's stack takes. */
export type TabParams = ParamsOf<RootParams["Tabs"]>;
export type Tab = keyof TabParams;
/** The routes in one tab's stack. */
export type StackParams<T extends Tab> = ParamsOf<TabParams[T]>;

/**
 * Navigation from a screen in `tab`: its own stack by route name, another
 * tab with `{ screen, params }`, and the root sheets.
 */
export function useTabNavigation<T extends Tab>() {
  return useNavigation<NativeStackNavigationProp<StackParams<T> & TabParams & RootParams>>();
}
