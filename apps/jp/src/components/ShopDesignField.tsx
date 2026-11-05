import { useState } from 'react';
import {
  shopDesignSchema,
  shopDesignImage,
  shopDesignLink,
  type ShopDesign,
} from '../lib/shop-design';
import { Field, FieldLabel, FieldError } from './ui/field';
import { Checkbox } from './ui/checkbox';
import { Input } from './ui/input';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';

function DesignPreview({ design }: { design: ShopDesign }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="border">
      {failed ? (
        <p className="p-3" role="status">
          preview unavailable. check the product is a public t-shirt.
        </p>
      ) : (
        <img
          src={shopDesignImage(design)}
          alt={`Flat ${design.color} t-shirt preview`}
          className="aspect-square w-full bg-white object-contain"
          onError={() => {
            setFailed(true);
          }}
        />
      )}
      <a
        href={shopDesignLink(design)}
        target="_blank"
        rel="noopener"
        className="block border-t p-3 underline"
      >
        VIEW PRODUCT ↗
      </a>
    </div>
  );
}

export function ShopDesignField({
  value,
  onChange,
}: {
  value: ShopDesign | null;
  onChange: (value: ShopDesign | null) => void;
}) {
  const parsed = shopDesignSchema.safeParse(value);
  return (
    <div className="space-y-3" data-feedback-id="post-design-picker">
      <Field orientation="horizontal">
        <Checkbox
          id="attach-shop-design"
          checked={Boolean(value)}
          onCheckedChange={(checked) => {
            onChange(checked ? { productUrl: '', color: 'white' } : null);
          }}
        />
        <FieldLabel htmlFor="attach-shop-design">add shop design</FieldLabel>
      </Field>
      {value && (
        <>
          <Field>
            <FieldLabel htmlFor="shop-product-url">product link</FieldLabel>
            <Input
              id="shop-product-url"
              type="url"
              placeholder="https://shop.bent.build/product/…"
              value={value.productUrl}
              required
              aria-invalid={Boolean(value.productUrl && !parsed.success)}
              onChange={(event) => {
                onChange({ ...value, productUrl: event.target.value });
              }}
            />
            {value.productUrl && !parsed.success && (
              <FieldError>use a product link from shop.bent.build</FieldError>
            )}
          </Field>
          <ToggleGroup
            value={[value.color]}
            variant="outline"
            aria-label="t-shirt colour"
            onValueChange={(colors) => {
              const color = colors[0];
              if (color === 'black' || color === 'white')
                onChange({ ...value, color });
            }}
          >
            <ToggleGroupItem value="black">BLACK</ToggleGroupItem>
            <ToggleGroupItem value="white">WHITE</ToggleGroupItem>
          </ToggleGroup>
          {parsed.success && (
            <DesignPreview
              key={shopDesignImage(parsed.data)}
              design={parsed.data}
            />
          )}
        </>
      )}
    </div>
  );
}
