import { useState, type SubmitEvent } from 'react';
import { mediaChangesSchema, type MediaChanges } from '../lib/media-edits';
import { categoryNames } from '../lib/category-icons';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Input } from './ui/input';
import { Field, FieldLabel } from './ui/field';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';

export function BulkMediaEditor({
  count,
  categories,
  places,
  busy,
  canApply,
  status,
  onApply,
  onClose,
}: {
  count: number;
  categories: string[];
  places: string[];
  busy: boolean;
  canApply: boolean;
  status: string;
  onApply: (changes: MediaChanges) => Promise<void>;
  onClose: () => void;
}) {
  const [changeTitle, setChangeTitle] = useState(false);
  const [changePlace, setChangePlace] = useState(false);
  const [changeCategories, setChangeCategories] = useState(false);
  const [title, setTitle] = useState('');
  const [place, setPlace] = useState('');
  const [mode, setMode] = useState<'add' | 'remove' | 'replace'>('add');
  const [names, setNames] = useState<string[]>([]);
  const [error, setError] = useState('');
  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = mediaChangesSchema.safeParse({
      ...(changeTitle ? { title } : {}),
      ...(changePlace ? { place } : {}),
      ...(changeCategories ? { categories: { mode, names } } : {}),
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message || 'Choose valid changes');
      return;
    }
    setError('');
    await onApply(parsed.data);
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-none border sm:max-w-lg"
        data-feedback-private
        data-feedback-redact
        showCloseButton
      >
        <DialogHeader>
          <DialogTitle>edit {count} photos</DialogTitle>
          <DialogDescription>
            checked fields apply to every selected photo. published photos
            update immediately.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            void submit(event);
          }}
          className="space-y-5"
        >
          <fieldset disabled={busy} className="min-w-0 space-y-5">
            <div className="space-y-2">
              <Field orientation="horizontal">
                <Checkbox
                  disabled={busy}
                  id="bulk-change-title"
                  checked={changeTitle}
                  onCheckedChange={setChangeTitle}
                />
                <FieldLabel htmlFor="bulk-change-title">
                  change title
                </FieldLabel>
              </Field>
              {changeTitle && (
                <Input
                  aria-label="new title"
                  required
                  maxLength={200}
                  value={title}
                  onChange={(event) => {
                    setTitle(event.target.value);
                  }}
                />
              )}
            </div>
            <div className="space-y-2">
              <Field orientation="horizontal">
                <Checkbox
                  disabled={busy}
                  id="bulk-change-place"
                  checked={changePlace}
                  onCheckedChange={setChangePlace}
                />
                <FieldLabel htmlFor="bulk-change-place">
                  change place
                </FieldLabel>
              </Field>
              {changePlace && (
                <>
                  <Input
                    aria-label="new place"
                    maxLength={100}
                    list="bulk-places"
                    value={place}
                    onChange={(event) => {
                      setPlace(event.target.value);
                    }}
                  />
                  <datalist id="bulk-places">
                    {places.map((value) => (
                      <option key={value} value={value} />
                    ))}
                  </datalist>
                  <p className="text-xs">leave empty to clear the place.</p>
                </>
              )}
            </div>
            <div className="space-y-3">
              <Field orientation="horizontal">
                <Checkbox
                  disabled={busy}
                  id="bulk-change-categories"
                  checked={changeCategories}
                  onCheckedChange={setChangeCategories}
                />
                <FieldLabel htmlFor="bulk-change-categories">
                  change categories
                </FieldLabel>
              </Field>
              {changeCategories && (
                <>
                  <div
                    className="flex flex-wrap gap-2"
                    role="group"
                    aria-label="category action"
                  >
                    {(
                      ['add', 'remove', 'replace'] satisfies Array<typeof mode>
                    ).map((value) => (
                      <Button
                        key={value}
                        size="sm"
                        disabled={busy}
                        aria-pressed={mode === value}
                        variant={mode === value ? 'default' : 'outline'}
                        onClick={() => {
                          setMode(value);
                        }}
                      >
                        {value.toUpperCase()}
                      </Button>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-3">
                    {categoryNames(categories).map(({ label, normalized }) => (
                      <Field
                        key={normalized}
                        orientation="horizontal"
                        className="w-auto gap-1.5"
                      >
                        <Checkbox
                          disabled={busy}
                          id={`bulk-category-${encodeURIComponent(normalized)}`}
                          checked={names.includes(label)}
                          onCheckedChange={(checked) => {
                            setNames((values) =>
                              checked
                                ? [...values, label]
                                : values.filter((value) => value !== label),
                            );
                          }}
                        />
                        <FieldLabel
                          htmlFor={`bulk-category-${encodeURIComponent(normalized)}`}
                        >
                          {label}
                        </FieldLabel>
                      </Field>
                    ))}
                  </div>
                  {mode === 'replace' && (
                    <p className="text-xs">
                      replaces all categories. select none to clear them.
                    </p>
                  )}
                </>
              )}
            </div>
          </fieldset>
          <p className="text-xs">
            capture date, time, coordinates and original files stay unchanged.
          </p>
          <p role="status" className="whitespace-pre-wrap empty:hidden">
            {error || status}
          </p>
          <div className="sticky -bottom-4 flex flex-wrap justify-end gap-3 border-t bg-popover py-3">
            <Button onClick={onClose}>{busy ? 'CLOSE' : 'CANCEL'}</Button>
            <Button
              type="submit"
              variant="default"
              disabled={
                busy ||
                !canApply ||
                !count ||
                !(changeTitle || changePlace || changeCategories) ||
                (changeCategories && mode !== 'replace' && !names.length)
              }
            >
              {busy ? 'SAVING' : `APPLY (${String(count)})`}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
