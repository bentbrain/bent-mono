import { HttpApi } from "@effect/platform";

import { DesignsGroup } from "./design-api";
import { ProductsGroup } from "./product-api";

export class ForeverTeeApi extends HttpApi.make("foreverTeeApi")
  .add(DesignsGroup)
  .add(ProductsGroup)
  .prefix("/v1") {}
