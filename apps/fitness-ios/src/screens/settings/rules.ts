/**
 * Settings rules shared by the Profile, Repeating week and Equipment
 * editors: dumbbell lists, validation messages, the rotation preview,
 * routine edits and equipment photo checks. Pure, so Bun tests cover it.
 */
import {
  addDays,
  displayLoad,
  exercises,
  formatShortDate,
  isNutrient,
  mondayOf,
  nutrientInfo,
  scheduled,
  settingsId,
  settingsSchema,
  toKg,
} from "@bent/fitness-contracts/domain";
import type { RecordEntry, Routine, Settings } from "@bent/fitness-contracts/domain";
import type { photoTypes } from "@bent/fitness-contracts";
import { z } from "zod";

export function formatDumbbells(values: number[], units: Settings["units"]) {
  return values.map((value) => displayLoad(value, units)).join(", ");
}

/** Reads "5, 7.5, 10" in the display unit as sorted, unique sizes in kg. */
export function parseDumbbells(text: string, units: Settings["units"]): { values: number[]; error?: undefined } | { values?: undefined; error: string } {
  const parts = text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const values = parts.map((part) => toKg(Number(part), units));
  if (values.some((value) => !Number.isFinite(value) || value <= 0 || value > 200))
    return {
      error: `Enter dumbbell sizes as positive numbers separated by commas, for example 5, 7.5, 10. Each size can be up to ${Math.floor(displayLoad(200, units))} ${units}.`,
    };
  if (values.length > 60) return { error: "Enter up to 60 dumbbell sizes." };
  return { values: [...new Set(values)].sort((a, b) => a - b) };
}

const fieldHelp: Partial<Record<string, { id: string; text: string }>> = {
  goal: { id: "goal", text: "Goal: enter up to 160 characters." },
  timezone: { id: "timezone", text: "Timezone: choose a timezone such as Australia/Brisbane." },
  age: { id: "age", text: "Age: enter a whole number from 16 to 120, or leave it empty." },
  heightCm: { id: "height", text: "Height: enter 80 to 250 cm, or leave it empty." },
  calories: { id: "calories", text: "Daily calorie trial: enter a whole number from 800 to 10000 kcal." },
  protein: { id: "protein", text: "Daily protein target: enter 20 to 400 g." },
  startDate: { id: "start-date", text: "Plan start date: choose a date." },
  introductionWeeks: { id: "introduction", text: "Introduction: enter a whole number of weeks from 0 to 8." },
};
const exerciseHelp: Partial<Record<string, { id: string; text: string }>> = {
  sets: { id: "sets", text: "enter 1 to 8 sets." },
  min: { id: "min", text: "enter a minimum from 1 to 600." },
  max: { id: "max", text: "enter a maximum from 1 to 600." },
  rest: { id: "rest", text: "enter 15 to 600 seconds of rest." },
};

/** Turns a settings validation issue into a sentence and the field to fix. */
export function describeIssue(issue: z.core.$ZodIssue | undefined, draft: Settings): { text: string; id?: string } {
  const [field, index, part, exerciseIndex, exerciseField] = issue?.path ?? [];
  if (field === "routines" && typeof index === "number") {
    const routine = draft.routines[index];
    const name = routine?.name.trim() || `Routine ${index + 1}`;
    if (part === "name") return { id: `routine-${index}`, text: `${name}: enter a routine name of up to 160 characters.` };
    if (part === "exercises" && typeof exerciseIndex === "number") {
      const exercise = routine?.exercises[exerciseIndex];
      const help = typeof exerciseField === "string" ? exerciseHelp[exerciseField] : undefined;
      return {
        id: `${help?.id ?? "min"}-${index}-${exerciseIndex}`,
        text: `${name}, ${exercise?.name ?? `exercise ${exerciseIndex + 1}`}: ${help?.text ?? "use a minimum above 0 that is no larger than the maximum."}`,
      };
    }
    return { text: `${name}: keep 1 to 15 exercises.` };
  }
  if (field === "routines") return { text: "Keep 1 to 8 routines." };
  if (field === "equipment" && typeof index === "number")
    return { id: `equipment-${index}`, text: "Equipment: enter a name of up to 160 characters and notes of up to 500." };
  if (field === "nutrients" && isNutrient(index)) {
    const { label, target } = nutrientInfo[index];
    return { id: `${index}-target`, text: `Daily ${label.toLowerCase()} target: enter ${target.min} to ${target.max} g, or leave it empty.` };
  }
  const help = typeof field === "string" ? fieldHelp[field] : undefined;
  return help ?? { text: "Check the highlighted settings and try again." };
}

/** Validates edited settings; on failure, the sentence and the field to fix. */
export function checkSettings(candidate: Settings): { data: Settings; error?: undefined } | { data?: undefined; error: { text: string; id?: string } } {
  const result = settingsSchema.safeParse(candidate);
  if (result.success) return { data: result.data };
  return { error: describeIssue(result.error.issues[0], candidate) };
}

/** The settings record's revision, which a settings save expects. */
export function settingsRevision(records: RecordEntry[]) {
  return records.find((record) => record.id === settingsId)?.revision ?? 0;
}

/** A number as editable text; empty for a value that is not set. */
export function numberText(value: number | null) {
  return value === null || Number.isNaN(value) ? "" : String(value);
}

/**
 * Reads typed number text. Empty text is `null` for an optional field and
 * NaN otherwise, which validation then reports for that field.
 */
export function parseNumberText(text: string, optional = false): number | null {
  const trimmed = text.trim().replace(",", ".");
  if (!trimmed) return optional ? null : Number.NaN;
  return Number(trimmed);
}

export const queuedNotice = "Settings queued for saving.";
export const unsavedNotice = "Unsaved settings";

/** The status line under the Save button. */
export function saveStatus(notice: string, sync: { error: string; pending: number; saving: boolean }) {
  if (notice !== queuedNotice) return notice;
  if (sync.error) return "Settings need attention. See the save error below.";
  return sync.pending || sync.saving ? "Settings pending sync." : "Settings saved.";
}

export const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export const weekdayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

export type PreviewDay = { day: string; weekday: string; type: "strength" | "run" | "rest"; title: string };

/** This week and next as the edited plan would schedule them, or null when it cannot. */
export function rotationPreview(draft: Settings, today: string): { label: string; days: PreviewDay[] }[] | null {
  if (!z.iso.date().safeParse(draft.startDate).success || !draft.routines.length) return null;
  const monday = mondayOf(today);
  return [0, 7].map((offset) => ({
    label: `Week of ${formatShortDate(addDays(monday, offset))}`,
    days: weekdays.map((weekday, index) => {
      const day = addDays(monday, offset + index);
      const plan = scheduled(draft, day);
      return {
        day,
        weekday,
        type: plan.type,
        title: plan.type === "strength" ? (plan.routine?.name ?? "Strength") : plan.type === "run" ? "Run" : "Rest",
      };
    }),
  }));
}

/** Swaps the item at `index` with its neighbour in `direction`. */
export function move<T>(list: T[], index: number, direction: -1 | 1): T[] {
  const target = index + direction;
  const item = list[index];
  const other = list[target];
  if (item === undefined || other === undefined) return list;
  const next = [...list];
  next[target] = item;
  next[index] = other;
  return next;
}

/** The included exercises, marked when the routine already has them. */
export function exerciseChoices(routine: Routine) {
  return exercises.map((exercise) => {
    const included = routine.exercises.some((item) => item.id === exercise.id);
    return { id: exercise.id, label: included ? `${exercise.name} · already in this routine` : exercise.name, included };
  });
}

/** Adds an included exercise with its default prescription, once. */
export function addExercise(routine: Routine, id: string): Routine {
  const exercise = exercises.find((item) => item.id === id);
  if (!exercise || routine.exercises.some((item) => item.id === id)) return routine;
  return { ...routine, exercises: [...routine.exercises, { ...exercise }] };
}

export function newRoutine(id: string): Routine {
  return { id, name: "New routine", exercises: exercises.slice(0, 1).map((exercise) => ({ ...exercise })) };
}

export function newEquipment(id: string): Settings["equipment"][number] {
  return { id, name: "New equipment", notes: "" };
}

/** Equipment photo limits, as Fitness enforces them. */
export const photoLimits = { bytes: 2 * 1024 * 1024, count: 20 } as const;
export const tooManyPhotos = "Keep up to 20 equipment photos. Remove a photo before adding another.";
export type PhotoType = (typeof photoTypes)[number];

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Decodes the first bytes of base64 text. */
export function base64Prefix(base64: string, count: number) {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of base64) {
    if (char === "=" || bytes.length >= count) break;
    const value = alphabet.indexOf(char);
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 255);
    }
  }
  return bytes;
}

/** The decoded size of base64 text in bytes. */
export function base64Bytes(base64: string) {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/** The image type the bytes start with, when it is one Fitness accepts. */
export function photoTypeOf(base64: string): PhotoType | null {
  const b = base64Prefix(base64, 12);
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg";
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => b[index] === value)) return "image/png";
  const text = String.fromCharCode(...b);
  if (text.slice(0, 4) === "RIFF" && text.slice(8, 12) === "WEBP") return "image/webp";
  return null;
}

/** Checks a chosen photo before upload; the error is safe to show. */
export function checkPhoto(base64: string | null | undefined, saved: number): { type: PhotoType; error?: undefined } | { type?: undefined; error: string } {
  if (saved >= photoLimits.count) return { error: tooManyPhotos };
  if (!base64) return { error: "Upload failed. Choose the photo again to retry." };
  const type = photoTypeOf(base64);
  if (!type) return { error: "Choose a JPEG, PNG or WebP photo." };
  if (base64Bytes(base64) > photoLimits.bytes) return { error: "Choose a photo under 2 MB." };
  return { type };
}

/**
 * A photo ID from the SHA-256 of its contents, shaped as a version 4 UUID
 * as the web app makes it, so a retried upload saves once.
 */
export function photoId(sha256Hex: string) {
  const bytes = Array.from({ length: 16 }, (_, index) => parseInt(sha256Hex.slice(index * 2, index * 2 + 2), 16) || 0);
  bytes[6] = ((bytes[6] ?? 0) & 15) | 64;
  bytes[8] = ((bytes[8] ?? 0) & 63) | 128;
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const extensions: Record<PhotoType, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/** The photo's name with the extension of the uploaded type, within 160 characters. */
export function photoName(fileName: string | null | undefined, type: PhotoType) {
  const base = (fileName ?? "").trim().replace(/\.[A-Za-z0-9]{1,5}$/, "") || "Equipment photo";
  const extension = `.${extensions[type]}`;
  return base.slice(0, 160 - extension.length) + extension;
}

/** What signing out deletes from this iPhone. */
export function signOutMessage(pending: number) {
  const queued =
    pending > 0
      ? `${pending === 1 ? "1 change" : `${pending} changes`} on this iPhone ${pending === 1 ? "has" : "have"} not synced and will be deleted. Export pending changes first to keep ${pending === 1 ? "it" : "them"}. `
      : "";
  return `${queued}Your saved data stays in your Fitness account. Apple Health sync stays connected until you disconnect it under Apple Health.`;
}

/** The starting plan in the words onboarding uses. */
export function planSummary(plan: Settings) {
  const strength = plan.schedule.filter((day) => day === "strength").length;
  const runs = plan.schedule.filter((day) => day === "run").length;
  return {
    strength: `${strength} days · ${plan.routines.map((routine) => routine.name).join(" and ")} take turns`,
    runs: `${runs} easy runs`,
    food: `${plan.calories} kcal · ${plan.protein} g protein`,
    introduction: `The first ${plan.introductionWeeks} weeks use up to two sets per exercise. Start light and learn the movements before increasing the load.`,
  };
}
