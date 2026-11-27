import { Platform } from "react-native";

/**
 * iOS 26 and later draw navigation bar items on Liquid Glass. Header
 * controls on those versions leave out their own fill so the glass is the
 * button's only surface.
 */
export const liquidGlass = Platform.OS === "ios" && Number.parseInt(String(Platform.Version), 10) >= 26;
