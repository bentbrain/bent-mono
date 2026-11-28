import { useState } from "react";
import { Alert, Linking, Pressable, View } from "react-native";
import { Image } from "expo-image";
import { openBrowserAsync } from "expo-web-browser";
import { useNavigation } from "@react-navigation/native";
import { useCSSVariable } from "uniwind";
import type { Exercise } from "@bent/fitness-contracts/domain";
import type { Guide } from "@bent/fitness-contracts/guides";
import { useAccount } from "../../account/AccountProvider";
import { haptic } from "../../ui/haptics";
import { Card } from "../../ui/Layout";
import { ListRow, ListSection } from "../../ui/List";
import { Symbol } from "../../ui/Symbol";
import { AppText } from "../../ui/Text";
import { cn, shape } from "../../ui/typography";
import { guideFor, guideImage, guideThumb, nameFor, prescriptionText, recordingNotes } from "../shared/exercise";
import { IllustrationViewer, illustrationRatio } from "./IllustrationViewer";
import { lastResult, measuredExercise, planEntries, tutorialUrl } from "./library";

/** The thumbnail's width to height ratio (512 × 206). */
const thumbRatio = 512 / 206;

/**
 * One exercise's guide: illustration, tutorial, how to record it with the
 * user's prescriptions and last result, setup, steps and what to watch for.
 * The Exercise screen shows it in full; the guide sheet shows it compact,
 * with the illustration's middle frames in place of the full picture.
 */
export function GuideContent({
  id,
  prescription,
  compact = false,
}: {
  id: string;
  prescription?: Exercise;
  compact?: boolean;
}) {
  const guide = guideFor(id);
  if (!guide)
    return (
      <Card testID="exercise-guide-fallback" className="gap-2">
        {prescription ? (
          <>
            <AppText weight="semibold">{prescriptionText(prescription)}</AppText>
            <AppText>{recordingNotes(prescription)}</AppText>
          </>
        ) : null}
        <AppText>
          Use a familiar movement and a light practice set. Ask a qualified trainer for setup and form guidance.
        </AppText>
      </Card>
    );
  return (
    <View className={compact ? "gap-5" : "gap-6"} testID={`exercise-guide-${id}`}>
      <Illustration guide={guide} compact={compact} />
      <Tutorial guide={guide} />
      <Recording id={id} />
      <ListSection title="Set up">
        <View className="px-4 py-3">
          <AppText>{guide.setup}</AppText>
        </View>
      </ListSection>
      <ListSection title="Move">
        {guide.steps.map((step, index) => (
          <View
            key={step}
            className="flex-row gap-3 px-4 py-3"
            accessible
            accessibilityLabel={`Step ${index + 1}: ${step}`}
          >
            <View className="size-7 items-center justify-center rounded-full bg-primary-soft">
              <AppText textRole="footnote" weight="bold" tone="primary" style={{ fontVariant: ["tabular-nums"] }}>
                {index + 1}
              </AppText>
            </View>
            <AppText className="flex-1 pt-0.5">{step}</AppText>
          </View>
        ))}
      </ListSection>
      <ListSection title="Watch for">
        <View className="flex-row gap-3 px-4 py-3">
          <Symbol name="exclamationmark.triangle.fill" size={18} tintColorClassName="accent-missed" />
          <AppText className="flex-1">{guide.avoid}</AppText>
        </View>
      </ListSection>
    </View>
  );
}

/** The illustration, tappable to view it full screen. */
function Illustration({ guide, compact }: { guide: Guide; compact: boolean }) {
  const [open, setOpen] = useState(false);
  const full = guideImage(guide.id);
  return (
    <View className="gap-2">
      <Pressable
        testID="exercise-illustration"
        accessibilityRole="imagebutton"
        accessibilityLabel={guide.illustrationAlt}
        accessibilityHint="Opens the illustration full screen"
        onPress={() => {
          haptic("light");
          setOpen(true);
        }}
        className="overflow-hidden bg-card-alt active:opacity-80"
        style={{ borderRadius: shape.card, borderCurve: "continuous" }}
      >
        <Image
          source={{ uri: compact ? guideThumb(guide.id) : full }}
          style={{ width: "100%", aspectRatio: compact ? thumbRatio : illustrationRatio }}
          contentFit="cover"
          cachePolicy="memory-disk"
          transition={150}
        />
        <View
          className="absolute bottom-2.5 right-2.5 flex-row items-center gap-1.5 rounded-full bg-card px-3 py-1.5"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Symbol
            name="arrow.up.left.and.arrow.down.right"
            size={12}
            weight="semibold"
            tintColorClassName="accent-primary"
          />
          <AppText textRole="caption" weight="semibold" tone="primary">
            {compact ? "Full illustration" : "Full screen"}
          </AppText>
        </View>
      </Pressable>
      <AppText textRole="footnote" tone="muted" className="px-1">
        AI-generated reference. Compare both views with the written cues and video demonstration.
      </AppText>
      <IllustrationViewer
        uri={full}
        alt={guide.illustrationAlt}
        title={nameFor(guide.id)}
        visible={open}
        onClose={() => setOpen(false)}
      />
    </View>
  );
}

/** Opens the YouTube tutorial in an in-app browser, or in YouTube or Safari when that is unavailable. */
function Tutorial({ guide }: { guide: Guide }) {
  const tint = useCSSVariable("--color-primary");
  const [opening, setOpening] = useState(false);
  const open = async () => {
    const url = tutorialUrl(guide.video);
    haptic("light");
    setOpening(true);
    try {
      await openBrowserAsync(url, {
        controlsColor: typeof tint === "string" ? tint : undefined,
        dismissButtonStyle: "done",
      });
    } catch {
      try {
        await Linking.openURL(url);
      } catch {
        haptic("error");
        Alert.alert("Couldn't open the tutorial", "Check your connection, then try again.");
      }
    } finally {
      setOpening(false);
    }
  };
  return (
    <ListSection footer="Tutorial opens on YouTube. Start light and stop if a movement hurts.">
      <Pressable
        testID="exercise-tutorial"
        accessibilityRole="link"
        accessibilityLabel={`Watch tutorial, ${guide.credit}`}
        accessibilityHint="Opens on YouTube"
        accessibilityState={{ busy: opening }}
        disabled={opening}
        onPress={() => void open()}
        className="active:bg-card-alt"
      >
        <View className={cn("min-h-16 flex-row items-center gap-3 px-4 py-3", opening && "opacity-60")}>
          <View className="size-8 items-center justify-center rounded-[9px] bg-primary">
            <Symbol name="play.fill" size={15} weight="semibold" tintColorClassName="accent-primary-foreground" />
          </View>
          <View className="min-w-0 flex-1 gap-0.5">
            <AppText weight="semibold" tone="primary">
              Watch tutorial
            </AppText>
            <AppText textRole="footnote" tone="muted">
              {guide.credit}
            </AppText>
          </View>
          <Symbol name="arrow.up.right" size={13} weight="semibold" tintColorClassName="accent-chevron" />
        </View>
      </Pressable>
    </ListSection>
  );
}

/** How to record the exercise, each routine's prescription and the last result. */
function Recording({ id }: { id: string }) {
  const { settings, sync } = useAccount();
  const navigation = useNavigation();
  const routines = settings?.routines ?? [];
  const measured = measuredExercise(routines, id);
  if (!measured) return null;
  const plan = planEntries(routines, id);
  const previous = lastResult(sync.records, id, settings?.units ?? "kg");
  return (
    <ListSection title="How to record it" testID="exercise-recording">
      <ListRow icon="square.and.pencil" label={recordingNotes(measured)} />
      {plan.length ? (
        plan.map(({ routine, exercise }, index) => (
          <ListRow
            key={`${routine}-${index}`}
            icon="calendar"
            label={routine}
            description={prescriptionText(exercise)}
          />
        ))
      ) : (
        <ListRow
          icon="calendar.badge.plus"
          label="Not in your routines"
          description="Add it to a routine from Repeating week."
          navigates
          testID="exercise-open-plan"
          accessibilityHint="Opens Repeating week"
          onPress={() => navigation.navigate("Tabs", { screen: "SettingsTab", params: { screen: "PlanSettings" } })}
        />
      )}
      <ListRow
        icon="clock.arrow.circlepath"
        label="Last time"
        description={previous ?? "Not recorded yet"}
        testID="exercise-last-result"
      />
    </ListSection>
  );
}
