import type { CollectionConfig } from "payload";

export const Categories: CollectionConfig = {
  slug: "categories",
  admin: {
    useAsTitle: "name",
    description: "Categories for the images",
  },
  fields: [
    { name: "name", type: "text" },
    {
      name: "images",
      type: "array",
      admin: {
        description: "Images for the category",
      },
      fields: [
        { name: "image", type: "upload", relationTo: "media" },
        {
          name: "tags",
          type: "array",
          fields: [{ name: "tag", type: "text" }],
        },
        {
          name: "isNsfw",
          label: "NSFW",
          type: "checkbox",
          defaultValue: false,
        },
      ],
    },
  ],
};
