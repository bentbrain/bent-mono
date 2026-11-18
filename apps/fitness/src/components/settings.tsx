import { useEffect, useRef, useState } from "react";
import { useBlocker } from "@tanstack/react-router";
import { Button } from "@bent/ui/button";
import {
  defaultSettings,
  displayLoad,
  exercises,
  localDate,
  settingsId,
  settingsSchema,
  toKg,
} from "../domain";
import type { Settings } from "../domain";
import type { z } from "zod";
import type { Sync } from "../sync";
import { download, SelectField, TextField } from "./fields";
import { deletePhoto, listPhotos, uploadPhoto } from "../server/photos";
function formatDumbbells(values: number[], units: Settings["units"]) {
  return values.map((value) => displayLoad(value, units)).join(", ");
}
function parseDumbbells(text: string, units: Settings["units"]) {
  const parts = text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const values = parts.map((part) => toKg(Number(part), units));
  if (
    values.some((value) => !Number.isFinite(value) || value <= 0 || value > 200)
  )
    return {
      error: `Enter dumbbell sizes as positive numbers separated by commas, for example 5, 7.5, 10. Each size can be up to ${Math.floor(displayLoad(200, units))} ${units}.`,
    };
  if (values.length > 60) return { error: "Enter up to 60 dumbbell sizes." };
  return { values: [...new Set(values)].sort((a, b) => a - b) };
}
const fieldHelp: Partial<Record<string, { id: string; text: string }>> = {
  goal: { id: "goal", text: "Goal: enter up to 160 characters." },
  timezone: {
    id: "timezone",
    text: "Timezone: choose a timezone such as Australia/Brisbane.",
  },
  age: {
    id: "age",
    text: "Age: enter a whole number from 16 to 120, or leave it empty.",
  },
  heightCm: {
    id: "height",
    text: "Height: enter 80 to 250 cm, or leave it empty.",
  },
  calories: {
    id: "calories",
    text: "Daily calorie trial: enter a whole number from 800 to 10000 kcal.",
  },
  protein: {
    id: "protein",
    text: "Daily protein target: enter 20 to 400 g.",
  },
  startDate: { id: "start-date", text: "Plan start date: choose a date." },
  introductionWeeks: {
    id: "introduction",
    text: "Introduction: enter a whole number of weeks from 0 to 8.",
  },
};
const exerciseHelp: Partial<Record<string, { id: string; text: string }>> = {
  sets: { id: "sets", text: "enter 1 to 8 sets." },
  min: { id: "min", text: "enter a minimum from 1 to 600." },
  max: { id: "max", text: "enter a maximum from 1 to 600." },
  rest: { id: "rest", text: "enter 15 to 600 seconds of rest." },
};
/** Turns a settings validation issue into a sentence and the field to fix. */
function describeIssue(
  issue: z.core.$ZodIssue | undefined,
  draft: Settings,
): { text: string; id?: string } {
  const [field, index, part, exerciseIndex, exerciseField] = issue?.path ?? [];
  if (field === "routines" && typeof index === "number") {
    const routine = draft.routines[index];
    const name = routine?.name.trim() || `Routine ${index + 1}`;
    if (part === "name")
      return {
        id: `routine-${index}`,
        text: `${name}: enter a routine name of up to 160 characters.`,
      };
    if (part === "exercises" && typeof exerciseIndex === "number") {
      const exercise = routine?.exercises[exerciseIndex];
      const help =
        typeof exerciseField === "string"
          ? exerciseHelp[exerciseField]
          : undefined;
      return {
        id: `${help?.id ?? "min"}-${index}-${exerciseIndex}`,
        text: `${name}, ${exercise?.name ?? `exercise ${exerciseIndex + 1}`}: ${help?.text ?? "use a minimum above 0 that is no larger than the maximum."}`,
      };
    }
    return { text: `${name}: keep 1 to 15 exercises.` };
  }
  if (field === "routines") return { text: "Keep 1 to 8 routines." };
  if (field === "equipment" && typeof index === "number")
    return {
      id: `equipment-${index}`,
      text: "Equipment: enter a name of up to 160 characters and notes of up to 500.",
    };
  const help = typeof field === "string" ? fieldHelp[field] : undefined;
  return help ?? { text: "Check the highlighted settings and try again." };
}
export function SettingsEditor({
  settings,
  revision,
  sync,
}: {
  settings: Settings;
  revision: number;
  sync: Sync;
}) {
  const [draft, setDraft] = useState(settings),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [photos, setPhotos] = useState<Awaited<ReturnType<typeof listPhotos>>>(
    [],
  );
  const [uploading, setUploading] = useState(false);
  const [originRevision, setOriginRevision] = useState(revision);
  const [savedDraft, setSavedDraft] = useState(settings);
  const [dumbbellText, setDumbbellText] = useState(() =>
    formatDumbbells(settings.dumbbellsKg, settings.units),
  );
  const [dumbbellError, setDumbbellError] = useState("");
  const [errorField, setErrorField] = useState<string>();
  const [exporting, setExporting] = useState(false);
  const summary = useRef<HTMLDivElement>(null);
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(savedDraft) ||
    dumbbellText !== formatDumbbells(savedDraft.dumbbellsKg, savedDraft.units);
  useBlocker({
    shouldBlockFn: () =>
      dirty &&
      !window.confirm("Leave Settings and discard your unsaved changes?"),
    enableBeforeUnload: dirty,
  });
  function showError(message: string, field?: string) {
    setError(message);
    setErrorField(field);
    requestAnimationFrame(() => summary.current?.focus());
  }
  function goToField(id: string) {
    const element = document.getElementById(id);
    element?.closest("details")?.setAttribute("open", "");
    element?.focus();
  }
  useEffect(() => {
    void listPhotos()
      .then(setPhotos)
      .catch(() =>
        setError("Equipment photos could not load. Retry when connected."),
      );
  }, []);
  function update(patch: Partial<Settings>) {
    setDraft((current) => ({ ...current, ...patch }));
    setNotice("Unsaved settings");
  }
  return (
    <section data-feedback-redact data-feedback-private>
      <p className="eyebrow">Make it yours</p>
      <h1>Settings</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const dumbbells = parseDumbbells(dumbbellText, draft.units);
          if (!dumbbells.values) {
            setDumbbellError(dumbbells.error);
            showError(dumbbells.error, "dumbbells");
            return;
          }
          setDumbbellError("");
          const result = settingsSchema.safeParse({
            ...draft,
            dumbbellsKg: dumbbells.values,
          });
          if (!result.success) {
            const issue = describeIssue(result.error.issues[0], draft);
            showError(issue.text, issue.id);
            return;
          }
          if (sync.put(result.data, settingsId, originRevision)) {
            setOriginRevision(originRevision + 1);
            setDraft(result.data);
            setSavedDraft(result.data);
            setDumbbellText(
              formatDumbbells(result.data.dumbbellsKg, result.data.units),
            );
            setNotice("Settings queued for saving.");
            setError("");
          } else
            showError(
              "Settings changed on another device or need attention. Check the message at the top of the page.",
            );
        }}
      >
        <div className="card form-grid">
          <TextField
            label="Goal"
            id="goal"
            value={draft.goal}
            onChange={(e) => update({ goal: e.target.value })}
            maxLength={160}
            required
          />
          <TextField
            label="Timezone"
            id="timezone"
            value={draft.timezone}
            onChange={(e) => update({ timezone: e.target.value })}
            required
            list="timezones"
          />
          <datalist id="timezones">
            {[
              "Australia/Brisbane",
              "Australia/Sydney",
              "Europe/London",
              "America/New_York",
              "UTC",
            ].map((t) => (
              <option key={t}>{t}</option>
            ))}
          </datalist>
          <TextField
            label="Age · optional"
            id="age"
            type="number"
            min={16}
            max={120}
            value={draft.age ?? ""}
            onChange={(e) =>
              update({ age: e.target.value ? Number(e.target.value) : null })
            }
          />
          <TextField
            label="Height · cm, optional"
            id="height"
            type="number"
            min={80}
            max={250}
            value={draft.heightCm ?? ""}
            onChange={(e) =>
              update({
                heightCm: e.target.value ? Number(e.target.value) : null,
              })
            }
          />
          <SelectField
            label="Display units"
            id="units"
            value={draft.units}
            onChange={(e) => {
              const units = e.target.value === "lb" ? "lb" : "kg";
              const parsed = parseDumbbells(dumbbellText, draft.units);
              if (parsed.values)
                setDumbbellText(formatDumbbells(parsed.values, units));
              update({ units });
            }}
          >
            <option value="kg">Kilograms</option>
            <option value="lb">Pounds</option>
          </SelectField>
          <TextField
            label="Daily calorie trial · kcal"
            id="calories"
            type="number"
            min={800}
            max={10000}
            value={draft.calories}
            onChange={(e) => update({ calories: Number(e.target.value) })}
          />
          <TextField
            label="Daily protein target · g"
            id="protein"
            type="number"
            min={20}
            max={400}
            value={draft.protein}
            onChange={(e) => update({ protein: Number(e.target.value) })}
          />
          <TextField
            label="Plan start date"
            id="start-date"
            type="date"
            value={draft.startDate}
            onChange={(e) => update({ startDate: e.target.value })}
          />
          <TextField
            label="Introduction · weeks at 2 sets"
            id="introduction"
            type="number"
            min={0}
            max={8}
            value={draft.introductionWeeks}
            onChange={(e) =>
              update({ introductionWeeks: Number(e.target.value) })
            }
          />
        </div>
        <h2>Weekly schedule</h2>
        <p>
          Strength days take turns through your routines in calendar order,
          counted from the plan start date. A missed day keeps its routine, so
          the next strength day still moves on to the next routine. To catch up,
          open the missed day in Your week and choose Do this workout today.
          Changing the start date can change which routine falls on each future
          day. Recorded workouts keep their results.
        </p>
        <div className="schedule-editor">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d, i) => (
            <SelectField
              key={d}
              label={d}
              id={`day-${i}`}
              value={draft.schedule[i]}
              onChange={(e) => {
                const value = e.target.value;
                if (value === "run" || value === "rest" || value === "strength")
                  update({
                    schedule: draft.schedule.map((s, j) =>
                      i === j ? value : s,
                    ),
                  });
              }}
            >
              <option value="strength">Strength</option>
              <option value="run">Easy run</option>
              <option value="rest">Rest</option>
            </SelectField>
          ))}
        </div>
        <h2>Your equipment</h2>
        <p>
          Add only the sizes you have checked. All loads in a workout mean one
          dumbbell.
        </p>
        <TextField
          label={`Dumbbell sizes · ${draft.units}, comma separated`}
          id="dumbbells"
          value={dumbbellText}
          inputMode="decimal"
          aria-invalid={Boolean(dumbbellError)}
          aria-describedby={dumbbellError ? "dumbbell-error" : undefined}
          onChange={(e) => {
            setDumbbellText(e.target.value);
            setDumbbellError("");
            setNotice("Unsaved settings");
          }}
        />
        {dumbbellError && (
          <p className="field-error" role="alert" id="dumbbell-error">
            {dumbbellError}
          </p>
        )}
        {draft.equipment.map((item, i) => (
          <div className="equipment-editor card" key={item.id}>
            <TextField
              label="Equipment"
              id={`equipment-${i}`}
              value={item.name}
              onChange={(e) =>
                update({
                  equipment: draft.equipment.map((v, j) =>
                    j === i ? { ...v, name: e.target.value } : v,
                  ),
                })
              }
            />
            <TextField
              label="Notes and confirmed sizes"
              id={`equipment-notes-${i}`}
              value={item.notes}
              maxLength={500}
              onChange={(e) =>
                update({
                  equipment: draft.equipment.map((v, j) =>
                    j === i ? { ...v, notes: e.target.value } : v,
                  ),
                })
              }
            />
            <Button
              appearance="ghost"
              onClick={() =>
                window.confirm(`Remove ${item.name} from your equipment?`) &&
                update({ equipment: draft.equipment.filter((_, j) => i !== j) })
              }
            >
              Remove equipment
            </Button>
          </div>
        ))}
        <Button
          appearance="outline"
          onClick={() =>
            update({
              equipment: [
                ...draft.equipment,
                { id: crypto.randomUUID(), name: "New equipment", notes: "" },
              ],
            })
          }
        >
          Add equipment
        </Button>
        <h2>Routines</h2>
        <p>
          Changes apply to new workouts. Sessions already started keep their
          exercise list and targets.
        </p>
        {draft.routines.map((routine, ri) => {
          function changeRoutine(next: typeof routine) {
            update({
              routines: draft.routines.map((r, i) => (i === ri ? next : r)),
            });
          }
          return (
            <details className="card routine-editor" key={routine.id}>
              <summary>
                {routine.name} · {routine.exercises.length} exercises
              </summary>
              <TextField
                label="Routine name"
                id={`routine-${ri}`}
                value={routine.name}
                onChange={(e) =>
                  changeRoutine({ ...routine, name: e.target.value })
                }
              />
              {routine.exercises.map((ex, ei) => {
                function change(patch: Partial<typeof ex>) {
                  changeRoutine({
                    ...routine,
                    exercises: routine.exercises.map((v, j) =>
                      j === ei ? { ...v, ...patch } : v,
                    ),
                  });
                }
                return (
                  <fieldset key={`${ex.id}:${ei}`}>
                    <legend>
                      {ei + 1}. {ex.name}
                    </legend>
                    <div className="row">
                      <Button
                        appearance="ghost"
                        aria-label={`Move ${ex.name} up`}
                        disabled={ei === 0}
                        onClick={() => {
                          const next = [...routine.exercises];
                          const before = next[ei - 1];
                          if (before) {
                            next[ei - 1] = ex;
                            next[ei] = before;
                            changeRoutine({ ...routine, exercises: next });
                          }
                        }}
                      >
                        Move up
                      </Button>
                      <Button
                        appearance="ghost"
                        aria-label={`Move ${ex.name} down`}
                        disabled={ei === routine.exercises.length - 1}
                        onClick={() => {
                          const next = [...routine.exercises];
                          const after = next[ei + 1];
                          if (after) {
                            next[ei + 1] = ex;
                            next[ei] = after;
                            changeRoutine({ ...routine, exercises: next });
                          }
                        }}
                      >
                        Move down
                      </Button>
                    </div>
                    <div className="prescription-grid">
                      <TextField
                        label="Sets"
                        id={`sets-${ri}-${ei}`}
                        type="number"
                        min={1}
                        max={8}
                        value={ex.sets}
                        onChange={(e) =>
                          change({ sets: Number(e.target.value) })
                        }
                      />
                      <TextField
                        label="Minimum"
                        id={`min-${ri}-${ei}`}
                        type="number"
                        min={1}
                        max={600}
                        value={ex.min}
                        onChange={(e) =>
                          change({ min: Number(e.target.value) })
                        }
                      />
                      <TextField
                        label="Maximum"
                        id={`max-${ri}-${ei}`}
                        type="number"
                        min={1}
                        max={600}
                        value={ex.max}
                        onChange={(e) =>
                          change({ max: Number(e.target.value) })
                        }
                      />
                      <TextField
                        label="Rest · seconds"
                        id={`rest-${ri}-${ei}`}
                        type="number"
                        min={15}
                        max={600}
                        value={ex.rest}
                        onChange={(e) =>
                          change({ rest: Number(e.target.value) })
                        }
                      />
                    </div>
                    <SelectField
                      label="Measure"
                      id={`mode-${ri}-${ei}`}
                      value={ex.mode}
                      onChange={(e) =>
                        change({
                          mode:
                            e.target.value === "seconds" ? "seconds" : "reps",
                        })
                      }
                    >
                      <option value="reps">Reps</option>
                      <option value="seconds">Seconds</option>
                    </SelectField>
                    <label>
                      <input
                        type="checkbox"
                        checked={ex.side}
                        onChange={(e) => change({ side: e.target.checked })}
                      />{" "}
                      Log both sides
                    </label>
                    <Button
                      appearance="ghost"
                      onClick={() =>
                        window.confirm(
                          `Remove ${ex.name} from this routine?`,
                        ) &&
                        changeRoutine({
                          ...routine,
                          exercises: routine.exercises.filter(
                            (_, i) => i !== ei,
                          ),
                        })
                      }
                    >
                      Remove exercise
                    </Button>
                  </fieldset>
                );
              })}
              <SelectField
                label="Add an exercise"
                id={`add-${ri}`}
                value=""
                onChange={(e) => {
                  const ex = exercises.find((v) => v.id === e.target.value);
                  if (
                    ex &&
                    !routine.exercises.some((item) => item.id === ex.id)
                  )
                    changeRoutine({
                      ...routine,
                      exercises: [...routine.exercises, { ...ex }],
                    });
                }}
              >
                <option value="">Choose exercise</option>
                {exercises.map((ex) => (
                  <option
                    key={ex.id}
                    value={ex.id}
                    disabled={routine.exercises.some(
                      (item) => item.id === ex.id,
                    )}
                  >
                    {ex.name}
                    {routine.exercises.some((item) => item.id === ex.id)
                      ? " · already in this routine"
                      : ""}
                  </option>
                ))}
              </SelectField>
              <Button
                appearance="ghost"
                onClick={() =>
                  window.confirm(
                    `Remove ${routine.name}? Recorded workouts keep their original exercises.`,
                  ) &&
                  update({
                    routines: draft.routines.filter((_, i) => i !== ri),
                  })
                }
              >
                Remove routine
              </Button>
            </details>
          );
        })}
        <Button
          appearance="outline"
          onClick={() =>
            update({
              routines: [
                ...draft.routines,
                {
                  id: crypto.randomUUID(),
                  name: "New routine",
                  exercises: exercises.slice(0, 1).map((e) => ({ ...e })),
                },
              ],
            })
          }
        >
          Add routine
        </Button>
        <div className="save-settings">
          <Button type="submit" appearance="primary">
            Save settings
          </Button>
          <span role="status">
            {notice === "Settings queued for saving."
              ? sync.error
                ? "Settings need attention. See the save error above."
                : sync.pending || sync.saving
                  ? "Settings pending sync."
                  : "Settings saved."
              : notice}
          </span>
          <div
            className="settings-error"
            ref={summary}
            tabIndex={-1}
            role={error ? "alert" : undefined}
          >
            {error && <p>{error}</p>}
            {error && errorField && (
              <Button appearance="ghost" onClick={() => goToField(errorField)}>
                Go to this setting
              </Button>
            )}
          </div>
        </div>
      </form>
      <h2>Private equipment photos</h2>
      <p>
        JPEG, PNG or WebP, up to 2 MB each. Only your account can access these
        photos.
      </p>
      <label className="bent-field">
        Upload equipment photo
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={uploading}
          onChange={async (e) => {
            const input = e.currentTarget;
            const file = input.files?.[0];
            if (!file) return;
            if (file.size > 2 * 1024 * 1024) {
              setError("Choose a photo under 2 MB.");
              return;
            }
            setUploading(true);
            try {
              const bytes = new Uint8Array(await file.arrayBuffer());
              const digest = new Uint8Array(
                await crypto.subtle.digest("SHA-256", bytes),
              );
              digest[6] = ((digest[6] ?? 0) & 15) | 64;
              digest[8] = ((digest[8] ?? 0) & 63) | 128;
              const hex = Array.from(digest.slice(0, 16), (b) =>
                b.toString(16).padStart(2, "0"),
              ).join("");
              const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
              let binary = "";
              for (const b of bytes) binary += String.fromCharCode(b);
              const type = file.type;
              if (
                type !== "image/jpeg" &&
                type !== "image/png" &&
                type !== "image/webp"
              )
                throw new Error("Choose a JPEG, PNG or WebP photo.");
              await uploadPhoto({
                data: {
                  id,
                  name: file.name,
                  type,
                  base64: btoa(binary),
                },
              });
              setPhotos(await listPhotos());
              setError("");
            } catch (err) {
              setError(
                err instanceof Error
                  ? err.message
                  : "Upload failed. Choose the photo again to retry.",
              );
            } finally {
              input.value = "";
              setUploading(false);
            }
          }}
        />
      </label>
      {uploading && <p role="status">Uploading photo…</p>}
      <div className="photos">
        {photos.map((p) => (
          <figure key={p.id}>
            <img src={`/api/photos/${p.id}`} alt={p.name} loading="lazy" />
            <figcaption>{p.name}</figcaption>
            <Button
              appearance="ghost"
              aria-label={`Remove photo ${p.name}`}
              onClick={async () => {
                try {
                  if (!window.confirm(`Remove photo ${p.name}?`)) return;
                  await deletePhoto({ data: p.id });
                  setPhotos(await listPhotos());
                } catch {
                  setError("Photo could not be removed. Retry when connected.");
                }
              }}
            >
              Remove photo
            </Button>
          </figure>
        ))}
      </div>
      <h2>Take your data with you</h2>
      {sync.pending > 0 ? (
        <p role="status">Finish syncing to export your account.</p>
      ) : (
        <Button
          appearance="outline"
          disabled={exporting}
          onClick={async () => {
            setExporting(true);
            setError("");
            try {
              const response = await fetch("/api/export");
              if (!response.ok)
                throw Error(
                  "Export could not be loaded. Check your connection and retry.",
                );
              const text = await response.text();
              JSON.parse(text);
              download("fitness-export.json", text);
            } catch {
              showError(
                "Export did not finish. No file was saved. Check your connection and try again.",
              );
            } finally {
              setExporting(false);
            }
          }}
        >
          {exporting
            ? "Preparing complete export…"
            : "Export account data and photos"}
        </Button>
      )}
      <p className="muted">
        Finish syncing before exporting. Store your export privately.
      </p>
    </section>
  );
}
export function Onboarding({ sync }: { sync: Sync }) {
  const [timezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  return (
    <section className="welcome card">
      <p className="eyebrow">Your first session starts here</p>
      <h1>Make room for progress.</h1>
      <p>
        Start with a beginner dumbbell plan. Choose your schedule, confirm your
        equipment and set your food targets in Settings.
      </p>
      <p>
        The first two weeks use two sets per exercise. Start light and learn the
        movements before increasing the load.
      </p>
      <Button
        appearance="primary"
        onClick={() =>
          sync.put(defaultSettings(localDate(timezone), timezone), settingsId)
        }
      >
        Set up my plan
      </Button>
    </section>
  );
}
