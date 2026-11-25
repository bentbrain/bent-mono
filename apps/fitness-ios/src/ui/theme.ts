import { useColorScheme } from "react-native";
import { designTokens } from "@bent/design-tokens";

export type Theme = {
  accent: string;
  background: string;
  foreground: string;
  muted: string;
  border: string;
  danger: string;
};

export function useTheme(): Theme {
  const dark = useColorScheme() === "dark";
  return dark
    ? {
        accent: designTokens.accentDark,
        background: designTokens.backgroundDark,
        foreground: designTokens.foregroundDark,
        muted: "#a3a3a3",
        border: "#3f3f3f",
        danger: "#ff6b6b",
      }
    : {
        accent: designTokens.accentLight,
        background: designTokens.backgroundLight,
        foreground: designTokens.foregroundLight,
        muted: "#5c5c5c",
        border: "#d4d4d4",
        danger: "#c62828",
      };
}
