import { Button } from "@bent/ui/button";
import { sameData } from "../domain";
import type { Entity } from "../domain";

/** The version of a record an editor opened. Saving checks it is still current. */
export type Opened<T extends Entity> = {
  id: string;
  revision: number;
  data: T;
};

/** Whether the record still matches the version the editor opened. */
export function editStatus(
  opened: Opened<Entity> | undefined,
  current: { revision: number; data: Entity | null } | undefined,
): "current" | "changed" | "removed" {
  if (!opened) return "current";
  if (!current?.data) return "removed";
  return current.revision === opened.revision &&
    sameData(current.data, opened.data)
    ? "current"
    : "changed";
}

/**
 * Explains that another device changed or removed the record being edited.
 * The form keeps the person's typed values until they choose what to save.
 */
export function EditConflict({
  status,
  noun,
  current,
  onKeepMine,
  onUseCurrent,
  onSaveAsNew,
}: {
  status: "changed" | "removed";
  noun: string;
  /** A short description of the saved version. */
  current?: string;
  onKeepMine: () => void;
  onUseCurrent: () => void;
  onSaveAsNew: () => void;
}) {
  return (
    <div className="edit-conflict" role="alert">
      {status === "changed" ? (
        <>
          <p>
            This {noun} changed on another device after you opened it. Saved
            version: {current}. Your changes are still in the form.
          </p>
          <Button appearance="primary" onClick={onKeepMine}>
            Save my changes instead
          </Button>
          <Button appearance="outline" onClick={onUseCurrent}>
            Load saved version
          </Button>
        </>
      ) : (
        <>
          <p>
            This {noun} was removed on another device. Your changes are still in
            the form.
          </p>
          <Button appearance="primary" onClick={onSaveAsNew}>
            Save my changes as a new {noun}
          </Button>
        </>
      )}
    </div>
  );
}
