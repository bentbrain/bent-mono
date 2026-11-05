import { useEffect, useMemo, useRef, useState } from 'react';
import { Checkbox } from '../components/ui/checkbox';
import { Field, FieldLabel } from '../components/ui/field';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../components/ui/dialog';
import { Button } from '../components/ui/button';
import { z } from 'zod';
import { galleryIds } from '../lib/model';
import { GalleryOrder } from '../components/GalleryOrder';
import { captureOrder, selectGalleryItem } from '../lib/gallery-order';
import { api } from '../lib/api-client';
import '../styles/globals.css';

const itemSchema = z.object({
  id: z.string(),
  status: z.string(),
  data: z.object({
    title: z.string(),
    captured_at: z.coerce.date(),
    poster: z.object({ src: z.string().optional() }).nullish(),
    poster_url: z.string().nullish(),
    asset: z.object({ url: z.string().optional() }).nullish(),
    source_url: z.string().nullish(),
  }),
});
function GalleryField({
  value,
  onChange,
  label,
}: {
  value: unknown;
  onChange: (value: string[]) => void;
  label: string;
}) {
  const [items, setItems] = useState<z.infer<typeof itemSchema>[]>([]),
    [error, setError] = useState('');
  const selected = useMemo(() => galleryIds(value), [value]);
  const preserveOrder = useRef(selected.length > 0);
  useEffect(() => {
    let cancelled = false;
    api('/api/trip/media')
      .then((data) => {
        if (!cancelled)
          setItems(
            z
              .object({ items: z.array(z.looseObject({ status: z.string() })) })
              .parse(data)
              .items.filter((item) => item.status === 'published')
              .map((item) => itemSchema.parse(item)),
          );
      })
      .catch(() => {
        if (!cancelled) setError('Could not load trip media');
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <fieldset className="trip-gallery-field border p-3 font-mono text-foreground">
      <legend>{label}</legend>
      <a href="/owner/media" target="_blank" rel="noopener">
        UPLOAD / EDIT MEDIA ↗
      </a>
      {error && <p role="alert">{error}</p>}
      <Dialog>
        <DialogTrigger render={<Button />}>CHOOSE MEDIA</DialogTrigger>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{label}</DialogTitle>
          </DialogHeader>
          <div className="trip-gallery-options mt-3 grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2">
            {captureOrder(items, 'desc').map((item) => (
              <div key={item.id}>
                <img
                  src={
                    item.data.poster?.src ||
                    item.data.poster_url ||
                    item.data.asset?.url ||
                    item.data.source_url ||
                    ''
                  }
                  alt=""
                  className="aspect-[1.15] w-full object-cover"
                />
                <Field orientation="horizontal" className="mt-2 gap-2">
                  <Checkbox
                    id={`trip-${item.id}`}
                    checked={selected.includes(item.id)}
                    onCheckedChange={(checked) => {
                      if (!checked && selected.length === 1)
                        preserveOrder.current = false;
                      onChange(
                        checked
                          ? selectGalleryItem(
                              selected,
                              item.id,
                              items,
                              preserveOrder.current,
                            )
                          : selected.filter((id) => id !== item.id),
                      );
                    }}
                  />
                  <FieldLabel htmlFor={`trip-${item.id}`}>
                    {item.data.title}
                  </FieldLabel>
                </Field>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
      <GalleryOrder
        selected={selected}
        items={items}
        onChange={(ids) => {
          preserveOrder.current = true;
          onChange(ids);
        }}
      />
    </fieldset>
  );
}
export const fields = { gallery: GalleryField };
