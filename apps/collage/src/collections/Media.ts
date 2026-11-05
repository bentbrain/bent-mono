import type { CollectionConfig } from "payload";

export const Media: CollectionConfig = {
  slug: "media",
  access: {
    create: () => process.env.MIGRATION_MAINTENANCE_MODE !== "true",
    delete: () => process.env.MIGRATION_MAINTENANCE_MODE !== "true",
    read: () => true,
    update: () => process.env.MIGRATION_MAINTENANCE_MODE !== "true",
  },
  fields: [
    {
      name: "alt",
      type: "text",
      required: true,
    },
    {
      name: "isNsfw",
      type: "checkbox",
      defaultValue: false,
    },
    {
      name: "categories",
      type: "relationship",
      relationTo: "categories",
      hasMany: true,
    },
  ],
  upload: true,
};
