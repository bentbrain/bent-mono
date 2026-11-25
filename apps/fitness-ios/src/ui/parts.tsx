import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTheme } from "./theme";

export function Page({ title, children, testID }: { title: string; children: ReactNode; testID: string }) {
  const theme = useTheme();
  return (
    <SafeAreaView style={[styles.page, { backgroundColor: theme.background }]} testID={testID}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={[styles.title, { color: theme.foreground }]}>
          {title}
        </Text>
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

export function Body({ children, muted, testID }: { children: ReactNode; muted?: boolean; testID?: string }) {
  const theme = useTheme();
  return (
    <Text testID={testID} style={[styles.body, { color: muted ? theme.muted : theme.foreground }]}>
      {children}
    </Text>
  );
}

export function Heading({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return <Text style={[styles.heading, { color: theme.foreground }]}>{children}</Text>;
}

export function Notice({ children, testID }: { children: ReactNode; testID?: string }) {
  const theme = useTheme();
  return (
    <View style={[styles.notice, { borderColor: theme.danger }]}>
      <Text testID={testID} style={[styles.body, { color: theme.foreground }]}>
        {children}
      </Text>
    </View>
  );
}

export function Button({
  label,
  onPress,
  appearance = "primary",
  disabled,
  busy,
  testID,
}: {
  label: string;
  onPress: () => void;
  appearance?: "primary" | "outline";
  disabled?: boolean;
  busy?: boolean;
  testID?: string;
}) {
  const theme = useTheme();
  const primary = appearance === "primary";
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: primary ? theme.accent : "transparent",
          borderColor: primary ? theme.accent : theme.border,
          opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
        },
      ]}
    >
      {busy ? (
        <ActivityIndicator color={primary ? "#fff" : theme.foreground} />
      ) : (
        <Text style={[styles.buttonLabel, { color: primary ? "#fff" : theme.foreground }]}>{label}</Text>
      )}
    </Pressable>
  );
}

export function Choice({
  label,
  selected,
  onPress,
  testID,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  testID?: string;
}) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.choice, { borderColor: selected ? theme.accent : theme.border }]}
    >
      <Text style={[styles.body, { color: theme.foreground, fontWeight: selected ? "600" : "400" }]}>{label}</Text>
    </Pressable>
  );
}

export function Row({
  label,
  value,
  testID,
  exact,
}: {
  label: string;
  value: string;
  testID?: string;
  /** A precise value for assistive technology and tests, such as a timestamp. */
  exact?: string;
}) {
  const theme = useTheme();
  return (
    <View style={[styles.row, { borderColor: theme.border }]}>
      <Text style={[styles.body, { color: theme.muted }]}>{label}</Text>
      <Text
        testID={testID}
        accessibilityValue={exact === undefined ? undefined : { text: exact }}
        style={[styles.body, { color: theme.foreground }]}
      >
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  content: { padding: 20, gap: 16 },
  title: { fontSize: 28, fontWeight: "700" },
  heading: { fontSize: 17, fontWeight: "600", marginTop: 8 },
  body: { fontSize: 16, lineHeight: 22 },
  notice: { borderWidth: 1, padding: 12 },
  button: { borderWidth: 1, paddingVertical: 14, paddingHorizontal: 16, alignItems: "center" },
  buttonLabel: { fontSize: 16, fontWeight: "600" },
  choice: { borderWidth: 1, padding: 12 },
  row: { flexDirection: "row", justifyContent: "space-between", borderBottomWidth: 1, paddingVertical: 8, gap: 12 },
});
