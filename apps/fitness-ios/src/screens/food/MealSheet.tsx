import type { JSX } from "react";
import { useLayoutEffect, useState } from "react";
import { View } from "react-native";
import type { StaticScreenProps } from "@react-navigation/native";
import { nutrientInfo, trackedNutrients } from "@bent/fitness-contracts/domain";
import { useConfiguredAccount } from "../../account/AccountProvider";
import { Button, IconButton } from "../../ui/Button";
import { NumberField, TextField } from "../../ui/Form";
import { ListSection, ListToggleRow } from "../../ui/List";
import { Notice, Screen } from "../../ui/Layout";
import { haptic } from "../../ui/haptics";
import { editStatus, hasRegular, mealInput, mealSummary, parseMeal, regularFor, savedMessage } from "./meals";
import type { EditState, Meal, MealInput, Opened } from "./meals";
import { useFoodNavigation } from "./navigation";
import { setFoodNotice } from "./notice";

export type FoodMealParams = { date: string; mealId?: string };

/**
 * Adds a meal to a day or edits one. Saving checks the meal is still the
 * version the sheet opened; when another device changed or removed it, the
 * typed values stay until the person chooses what to save.
 */
export function FoodMealScreen({ route }: StaticScreenProps<FoodMealParams>): JSX.Element {
  const { date, mealId } = route.params;
  const { sync, settings } = useConfiguredAccount();
  const tracked = trackedNutrients(settings);
  const navigation = useFoodNavigation();
  const [editing, setEditing] = useState<Opened<Meal> | undefined>(() => {
    const record = mealId ? sync.records.find((item) => item.id === mealId) : undefined;
    return record?.data.kind === "meal" ? { id: record.id, revision: record.revision, data: record.data } : undefined;
  });
  // The meal was removed before the sheet opened, so the form adds a new one.
  const [missing] = useState(() => Boolean(mealId) && !editing);
  const [input, setInput] = useState<MealInput>(() => mealInput(editing?.data));
  const [keep, setKeep] = useState(false);
  const [error, setError] = useState("");
  const [failed, setFailed] = useState(false);
  const [checked, setChecked] = useState<Exclude<EditState, "current">>();

  const live = editing ? sync.records.find((record) => record.id === editing.id) : undefined;
  const derived = editStatus(editing, live);
  const status = derived === "current" ? checked : derived;
  const saved = live?.data.kind === "meal" ? live.data : undefined;

  useLayoutEffect(() => {
    navigation.setOptions({
      title: editing ? "Edit food" : "Add food",
      headerLeft: () => <IconButton tone="plain" icon="xmark" label={editing ? "Cancel edit" : "Cancel"} onPress={() => navigation.goBack()} testID="meal-cancel" />,
    });
  }, [navigation, editing]);

  /** Opens a version in the form. `reload` replaces the typed values. */
  function open(next: Opened<Meal> | undefined, reload = true) {
    setEditing(next);
    setChecked(undefined);
    if (reload) setInput(mealInput(next?.data));
  }

  function savedVersion(): Opened<Meal> | undefined {
    const current = editing ? sync.latest(editing.id) : undefined;
    return editing && current?.data?.kind === "meal" ? { id: editing.id, revision: current.revision, data: current.data } : undefined;
  }

  function save(target: Opened<Meal> | undefined) {
    const result = parseMeal(input, target?.data.date ?? date, tracked, target?.data);
    if ("error" in result) {
      setError(result.error);
      haptic("error");
      return;
    }
    if (target) {
      const state = editStatus(target, sync.latest(target.id));
      if (state !== "current") {
        setChecked(state);
        setError("");
        haptic("warning");
        return;
      }
    }
    if (!sync.put(result.meal, target?.id, target?.revision ?? 0)) {
      setFailed(true);
      haptic("error");
      return;
    }
    const duplicate = hasRegular(sync.records, result.meal);
    if (keep && !duplicate) sync.put(regularFor(result.meal));
    setFoodNotice(savedMessage(result.meal, Boolean(target), keep && duplicate));
    haptic("success");
    navigation.goBack();
  }

  return (
    <Screen testID="screen-food-meal">
      {missing ? <Notice tone="warning">This food was removed on another device. Saving adds it as new food.</Notice> : null}
      <View className="gap-4">
        <TextField
          label="Meal or snack"
          value={input.name}
          onChangeText={(name) => setInput((value) => ({ ...value, name }))}
          placeholder="e.g. Yoghurt and berries"
          maxLength={160}
          autoFocus
          autoCapitalize="sentences"
          returnKeyType="next"
          testID="meal-name"
        />
        <View className="flex-row gap-3">
          <NumberField
            label="Calories"
            unit="kcal"
            value={input.calories}
            onChangeText={(calories) => setInput((value) => ({ ...value, calories }))}
            hint="0 to 10000"
            className="flex-1"
            testID="meal-calories"
          />
          <NumberField
            label="Protein"
            unit="g"
            value={input.protein}
            onChangeText={(protein) => setInput((value) => ({ ...value, protein }))}
            hint="0 to 500"
            className="flex-1"
            testID="meal-protein"
          />
        </View>
        {tracked.length ? (
          <View className="flex-row gap-3">
            {tracked.map((nutrient) => (
              <NumberField
                key={nutrient}
                label={nutrientInfo[nutrient].label}
                unit="g"
                value={input[nutrient]}
                onChangeText={(text) => setInput((value) => ({ ...value, [nutrient]: text }))}
                hint="Optional"
                className="flex-1"
                testID={`meal-${nutrient}`}
              />
            ))}
          </View>
        ) : null}
      </View>
      <ListSection footer="Saved meals appear on the Food screen, ready to add with one tap.">
        <ListToggleRow label="Add to Saved meals" value={keep} onValueChange={setKeep} testID="meal-save-regular" />
      </ListSection>
      {status ? (
        <Notice
          tone="warning"
          testID="meal-conflict"
          action={
            status === "changed" ? (
              <View className="gap-2">
                <Button
                  label="Save my changes instead"
                  onPress={() => {
                    const next = savedVersion();
                    if (!next) return;
                    open(next, false);
                    save(next);
                  }}
                  fullWidth
                  testID="meal-keep-mine"
                />
                <Button label="Load saved version" tone="secondary" onPress={() => open(savedVersion())} fullWidth testID="meal-use-saved" />
              </View>
            ) : (
              <Button label="Save my changes as new food" onPress={() => save(undefined)} fullWidth testID="meal-save-new" />
            )
          }
        >
          {status === "changed"
            ? `This food changed on another device after you opened it. Saved version: ${saved ? `${saved.name} · ${mealSummary(saved, tracked)}` : "unavailable"}. Your changes are still in the form.`
            : "This food was removed on another device. Your changes are still in the form."}
        </Notice>
      ) : null}
      <Button
        label={editing ? "Save food changes" : "Add food"}
        icon={editing ? "checkmark" : "plus"}
        onPress={() => save(editing)}
        disabled={Boolean(status)}
        fullWidth
        testID="meal-save"
      />
      {error ? (
        <Notice tone="danger" testID="meal-error">
          {error}
        </Notice>
      ) : null}
      {failed && sync.error ? (
        <Notice tone="danger" testID="meal-sync-error">
          {sync.error}
        </Notice>
      ) : null}
    </Screen>
  );
}
