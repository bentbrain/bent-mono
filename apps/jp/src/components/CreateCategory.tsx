import { useEffect, useId, useState, type SubmitEvent } from 'react';
import { api } from '../lib/api-client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ownerCategoriesQuery } from '../lib/owner-queries';
import {
  categoryCollectionSchema,
  type CategoryCollection,
} from '../lib/category-collection-model';
import { normalizeCategory } from '../lib/category-icons';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Field, FieldLabel } from './ui/field';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './ui/dialog';

export function CreateCategory({
  onCreated,
}: {
  onCreated: (collection: CategoryCollection, name: string) => void;
}) {
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: async (name: string) =>
      categoryCollectionSchema.parse(
        await api('/api/trip/categories', { name }),
      ),
    onMutate: () =>
      client.cancelQueries({ queryKey: ownerCategoriesQuery.queryKey }),
    onSuccess: (collection) => {
      client.setQueryData(ownerCategoriesQuery.queryKey, collection);
    },
    onError: () => {
      // Cancellation can leave the first load pending with no data or error.
      // Recover the active query even when category creation was rejected.
      void client.invalidateQueries({
        queryKey: ownerCategoriesQuery.queryKey,
      });
    },
  });
  const id = useId();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(true);
  }, []);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function create(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    event.stopPropagation();
    const category = normalizeCategory(name);
    if (!category) {
      setError('choose a category of 1 to 40 characters');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const collection = await mutation.mutateAsync(category.label);
      const saved = collection.categories.find(
        (item) => item.normalized === category.normalized,
      );
      onCreated(collection, saved?.label || category.label);
      window.dispatchEvent(new Event('category-icons:changed'));
      setName('');
      setOpen(false);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'could not create category',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) {
          setOpen(value);
          setError('');
        }
      }}
    >
      <DialogTrigger
        render={
          <Button type="button" variant="outline" size="sm" disabled={!ready} />
        }
      >
        NEW CATEGORY
      </DialogTrigger>
      <DialogContent data-feedback-id="create-category">
        <DialogHeader>
          <DialogTitle>new category</DialogTitle>
          <DialogDescription>
            reuse an icon, or generate one automatically.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            void create(event);
          }}
          className="space-y-4"
        >
          <Field>
            <FieldLabel htmlFor={id}>name</FieldLabel>
            <Input
              id={id}
              value={name}
              maxLength={40}
              required
              disabled={busy}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          </Field>
          <Button type="submit" disabled={busy}>
            {busy ? 'CREATING' : 'CREATE'}
          </Button>
          <p role="status" className="text-xs empty:hidden">
            {error}
          </p>
        </form>
      </DialogContent>
    </Dialog>
  );
}
