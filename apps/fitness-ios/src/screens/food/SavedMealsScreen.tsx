import type { JSX } from "react";
import { useState } from "react";
import { Alert } from "react-native";
import { trackedNutrients } from "@bent/fitness-contracts/domain";
import { useConfiguredAccount } from "../../account/AccountProvider";
import { IconButton } from "../../ui/Button";
import { ListRow, ListSection } from "../../ui/List";
import { EmptyState, Notice, Screen } from "../../ui/Layout";
import { haptic } from "../../ui/haptics";
import { mealSummary, regulars } from "./meals";

/** Saved meals and removing them. Days already logged keep their food. */
export function FoodSavedMealsScreen(): JSX.Element {
  const { sync, settings } = useConfiguredAccount();
  const tracked = trackedNutrients(settings);
  const saved = regulars(sync.records);
  const [failed, setFailed] = useState(false);

  function remove(item: (typeof saved)[number]) {
    Alert.alert(`Remove ${item.data.name}?`, "Food you already logged stays on its day.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => {
          const removed = sync.put(null, item.id, item.revision);
          setFailed(!removed);
          haptic(removed ? "success" : "error");
        },
      },
    ]);
  }

  return (
    <Screen testID="screen-food-saved-meals">
      {saved.length ? (
        <ListSection footer="Turn on Add to Saved meals when you add food to save more.">
          {saved.map((item, index) => (
            <ListRow
              key={item.id}
              label={item.data.name}
              description={mealSummary(item.data, tracked)}
              trailing={
                <IconButton
                  icon="trash"
                  tone="danger"
                  size={34}
                  label={`Remove saved meal ${item.data.name}`}
                  onPress={() => remove(item)}
                  testID={`saved-meal-remove-${index}`}
                />
              }
            />
          ))}
        </ListSection>
      ) : (
        <EmptyState
          icon="bookmark"
          title="No saved meals"
          body="Turn on Add to Saved meals when you add food to reuse it with one tap."
        />
      )}
      {failed && sync.error ? <Notice tone="danger">{sync.error}</Notice> : null}
    </Screen>
  );
}
