import type { GlobalConfig } from "payload";

export const Backgrounds: GlobalConfig = {
  slug: "backgrounds",
  admin: {
    description: "Backgrounds for the canvas",
  },
  fields: [
    {
      name: "backgrounds",
      type: "array",
      admin: {
        description: "Backgrounds for the canvas",
      },
      fields: [{ name: "image", type: "upload", relationTo: "media" }],
    },
  ],
};
