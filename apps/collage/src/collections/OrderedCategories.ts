import { type GlobalConfig } from "payload";

const OrderedCategories: GlobalConfig = {
  slug: "ordered-categories",
  fields: [
    {
      name: "categories",
      type: "relationship",
      relationTo: "categories",
      hasMany: true,
      unique: true,
      required: true,
      admin: {
        isSortable: true,
      },
    },
  ],
};

export default OrderedCategories;
