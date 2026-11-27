import { Pressable, View } from "react-native";
import { useConfiguredAccount } from "../../account/AccountProvider";
import { Segmented } from "../../ui/Form";
import { haptic } from "../../ui/haptics";
import { Card, Screen, SectionTitle } from "../../ui/Layout";
import { AppText } from "../../ui/Text";
import { cn } from "../../ui/typography";
import { InputField, NumberInput, SaveBar, useDiscardGuard, useFieldFocus, useSettingsEditor } from "./parts";

const timezones = ["Australia/Brisbane", "Australia/Sydney", "Europe/London", "America/New_York", "UTC"];

export function ProfileScreen() {
  const { sync } = useConfiguredAccount();
  return <ProfileEditor key={sync.editorReset} />;
}

/** Goal, timezone, body details, display units and the daily food targets. */
function ProfileEditor() {
  const editor = useSettingsEditor();
  const { draft, update } = editor;
  const fields = useFieldFocus();
  useDiscardGuard(editor.dirty);
  const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const choices = [...new Set([deviceZone, ...timezones])];

  return (
    <Screen testID="screen-profile">
      <Card>
        <InputField
          label="Goal"
          value={draft.goal}
          onChangeText={(goal) => update({ goal })}
          maxLength={160}
          inputRef={fields.register("goal")}
          testID="profile-goal"
        />
        <InputField
          label="Timezone"
          value={draft.timezone}
          onChangeText={(timezone) => update({ timezone })}
          autoCapitalize="none"
          autoCorrect={false}
          inputRef={fields.register("timezone")}
          hint="An IANA timezone, such as Australia/Brisbane. Today and your week follow it."
          testID="profile-timezone"
        />
        <View className="flex-row flex-wrap gap-2" accessibilityLabel="Timezone suggestions">
          {choices.map((zone) => (
            <Pressable
              key={zone}
              accessibilityRole="button"
              accessibilityLabel={zone === deviceZone ? `Use this iPhone's timezone, ${zone}` : `Use ${zone}`}
              accessibilityState={{ selected: draft.timezone === zone }}
              onPress={() => {
                haptic("selection");
                update({ timezone: zone });
              }}
              className={cn("rounded-full px-3 py-1.5 active:opacity-70", draft.timezone === zone ? "bg-primary" : "bg-card-alt")}
            >
              <AppText textRole="footnote" weight="medium" tone={draft.timezone === zone ? "inverse" : "secondary"}>
                {zone === deviceZone ? `${zone} · this iPhone` : zone}
              </AppText>
            </Pressable>
          ))}
        </View>
      </Card>

      <View className="gap-3">
        <SectionTitle>About you</SectionTitle>
        <Card>
          <NumberInput
            label="Age · optional"
            value={draft.age}
            optional
            integer
            onChange={(age) => update({ age })}
            inputRef={fields.register("age")}
            testID="profile-age"
          />
          <NumberInput
            label="Height · optional"
            unit="cm"
            value={draft.heightCm}
            optional
            onChange={(heightCm) => update({ heightCm })}
            inputRef={fields.register("height")}
            testID="profile-height"
          />
          <View className="gap-1.5">
            <AppText textRole="footnote" weight="medium" tone="secondary">
              Display units
            </AppText>
            <Segmented
              label="Display units"
              value={draft.units}
              options={[
                { value: "kg", label: "Kilograms" },
                { value: "lb", label: "Pounds" },
              ]}
              onChange={(units) => update({ units })}
              testID="profile-units"
            />
          </View>
        </Card>
      </View>

      <View className="gap-3">
        <SectionTitle>Daily food targets</SectionTitle>
        <Card>
          <NumberInput
            label="Daily calorie trial"
            unit="kcal"
            value={draft.calories}
            integer
            onChange={(calories) => update({ calories: calories ?? Number.NaN })}
            inputRef={fields.register("calories")}
            testID="profile-calories"
          />
          <NumberInput
            label="Daily protein target"
            unit="g"
            value={draft.protein}
            onChange={(protein) => update({ protein: protein ?? Number.NaN })}
            inputRef={fields.register("protein")}
            testID="profile-protein"
          />
        </Card>
      </View>

      <SaveBar
        onSave={() => editor.save(draft)}
        status={editor.status}
        error={editor.error}
        syncError={editor.sync.error}
        onGoTo={fields.focus}
      />
    </Screen>
  );
}
