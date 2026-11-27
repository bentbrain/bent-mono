import { View } from "react-native";
import {
  completedActivity,
  effectivePrescription,
  formatDate,
  nextSession,
  sessionMinutes,
} from "@bent/fitness-contracts/domain";
import { useConfiguredAccount } from "../../account/AccountProvider";
import { Button } from "../../ui/Button";
import { Badge, Card } from "../../ui/Layout";
import { ListRow, ListSection } from "../../ui/List";
import { AppText } from "../../ui/Text";
import { ExerciseThumb, prescriptionText } from "../shared/exercise";
import { dayInfo, recordedText } from "./logic";
import { useWeekNavigation } from "./navigation";
import { ExerciseHelp, ResumePanel, stateTone } from "./parts";
import { useStartWorkout } from "./useStartWorkout";

function Body({ children }: { children: string }) {
  return (
    <AppText textRole="footnote" tone="secondary">
      {children}
    </AppText>
  );
}

/** The selected day: its session, how to start or record it, and what is next. */
export function DayPanel({ day }: { day: string }) {
  const { sync, settings, today, setDate } = useConfiguredAccount();
  const navigation = useWeekNavigation();
  const { start, starting, active } = useStartWorkout();
  const activity = completedActivity(sync.records);
  const info = dayInfo(settings, activity, day, today);
  const { plan } = info;
  const label = day === today ? "Today" : formatDate(day);
  const upcoming = nextSession(settings, day, sync.records);
  const following = upcoming && upcoming.date !== day ? upcoming : undefined;
  const routine = plan.type === "strength" ? plan.routine : undefined;
  const recorded = info.completed || info.other;

  const openHistory = () => {
    setDate(day);
    navigation.navigate("ProgressTab", { screen: "History", initial: false });
  };
  const openRun = (date: string) => navigation.navigate("Run", { date });

  const next = following ? (
    <AppText textRole="footnote" tone="muted" testID="next-session">
      Next: {formatDate(following.date)} ·{" "}
      {following.plan.type === "strength" && following.plan.routine ? (
        <AppText
          textRole="footnote"
          weight="semibold"
          tone="primary"
          accessibilityRole="link"
          onPress={() => {
            const nextRoutine = following.plan.routine;
            if (nextRoutine) navigation.navigate("Plan", { date: following.date, routineId: nextRoutine.id });
          }}
        >
          {following.plan.routine.name}
        </AppText>
      ) : (
        <AppText textRole="footnote" weight="semibold" tone="primary" accessibilityRole="link" onPress={() => openRun(following.date)}>
          Easy run
        </AppText>
      )}
    </AppText>
  ) : null;

  return (
    <>
      {active ? (
        <ResumePanel record={active} />
      ) : (
        <Card testID="day-panel">
          <View className="flex-row flex-wrap items-center gap-2">
            <AppText textRole="footnote" weight="semibold" tone="secondary">
              {label}
            </AppText>
            <Badge label={info.status} tone={stateTone[info.state]} />
          </View>
          <AppText textRole="title" weight="bold" accessibilityRole="header">
            {info.name}
          </AppText>
          {recorded ? (
            <>
              <Body>{recordedText(info, day, today)}</Body>
              <Button label="View results" tone="secondary" icon="list.bullet.clipboard" onPress={openHistory} testID="view-results" />
              {next}
            </>
          ) : routine ? (
            <>
              <View className="flex-row flex-wrap gap-x-3 gap-y-1">
                <AppText textRole="footnote" tone="muted">
                  About {sessionMinutes(routine, plan.intro)} min
                </AppText>
                <AppText textRole="footnote" tone="muted">
                  {routine.exercises.length} exercises
                </AppText>
                <AppText textRole="footnote" tone="muted">
                  {plan.intro ? "Introduction · up to 2 sets" : "Full sets"}
                </AppText>
              </View>
              <View className="gap-2">
                {day === today ? (
                  <Button
                    label={starting ? "Opening workout…" : "Start workout"}
                    icon="play.fill"
                    busy={starting}
                    onPress={() => start(routine, today)}
                    testID="start-workout"
                  />
                ) : null}
                <Button
                  label="View workout plan"
                  tone={day === today ? "secondary" : "primary"}
                  icon="list.bullet"
                  onPress={() => navigation.navigate("Plan", { date: day, routineId: routine.id })}
                  testID="view-plan"
                />
              </View>
              {day > today ? <Body>Planned. The plan shows last time's results and suggested loads.</Body> : null}
              {day < today ? <Body>Not recorded. Open the plan to log it for this date or do it today.</Body> : null}
            </>
          ) : plan.type === "run" ? (
            <>
              <Body>Keep it comfortable enough to talk in sentences.</Body>
              <Button
                label={day > today ? "View run plan" : "Record run"}
                icon="figure.run"
                onPress={() => openRun(day)}
                testID="record-run"
              />
            </>
          ) : (
            <>
              <Body>
                {upcoming
                  ? "A recovery day. Light walking is fine."
                  : "No training days are scheduled. Choose days in Repeating week."}
              </Body>
              {upcoming ? null : (
                <Button
                  label="Edit repeating week"
                  tone="tinted"
                  icon="calendar"
                  onPress={() => navigation.navigate("Schedule")}
                  testID="edit-repeating-week"
                />
              )}
              {next}
              {day <= today ? (
                <Button
                  label="Record an unscheduled run"
                  tone="secondary"
                  icon="figure.run"
                  onPress={() => openRun(day)}
                  testID="record-unscheduled-run"
                />
              ) : null}
            </>
          )}
        </Card>
      )}
      {routine && !recorded ? (
        <ListSection title={`${routine.name} exercises`} testID="day-exercises">
          {routine.exercises.map((exercise, index) => (
            <ListRow
              key={`${exercise.id}:${index}`}
              label={exercise.name}
              description={prescriptionText(effectivePrescription(exercise, plan.intro))}
              leading={<ExerciseThumb id={exercise.id} width={64} />}
              trailing={<ExerciseHelp id={exercise.id} />}
            />
          ))}
        </ListSection>
      ) : null}
    </>
  );
}
