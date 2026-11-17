import { useEffect, useState } from "react";
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
import type { Sync } from "../sync";
import { SelectField, TextField } from "./fields";
import { deletePhoto, listPhotos, uploadPhoto } from "../server/photos";
export function SettingsEditor({
  settings,
  sync,
}: {
  settings: Settings;
  sync: Sync;
}) {
  const [draft, setDraft] = useState(settings),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [photos, setPhotos] = useState<Awaited<ReturnType<typeof listPhotos>>>(
    [],
  );
  const [uploading, setUploading] = useState(false);
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
          const result = settingsSchema.safeParse(draft);
          if (!result.success) {
            setError(result.error.issues[0]?.message ?? "Check your settings.");
            return;
          }
          if (sync.put(result.data, settingsId)) {
            setNotice("Settings queued for saving.");
            setError("");
          }
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
            onChange={(e) =>
              update({ units: e.target.value === "lb" ? "lb" : "kg" })
            }
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
          Strength sessions alternate through your routines from the plan start
          date.
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
          defaultValue={draft.dumbbellsKg
            .map((v) => displayLoad(v, draft.units))
            .join(", ")}
          key={draft.units}
          onBlur={(e) => {
            const values = e.target.value.trim()
              ? e.target.value
                  .split(",")
                  .map((v) => toKg(Number(v.trim()), draft.units))
              : [];
            update({ dumbbellsKg: values });
          }}
        />
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
                  <fieldset key={ei}>
                    <legend>
                      {ei + 1}. {ex.name}
                    </legend>
                    <TextField
                      label="Exercise name"
                      id={`name-${ri}-${ei}`}
                      value={ex.name}
                      readOnly
                    />
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
                  if (ex)
                    changeRoutine({
                      ...routine,
                      exercises: [...routine.exercises, { ...ex }],
                    });
                }}
              >
                <option value="">Choose exercise</option>
                {exercises.map((ex) => (
                  <option key={ex.id} value={ex.id}>
                    {ex.name}
                  </option>
                ))}
              </SelectField>
              <Button
                appearance="ghost"
                onClick={() =>
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
          <span role="status">{notice}</span>
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
              onClick={async () => {
                try {
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
        <a
          className="bent-button bent-button--outline export-link"
          href="/api/export"
        >
          Export account data and photos
        </a>
      )}
      <p className="muted">
        Finish syncing before exporting. Store your export privately.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
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
