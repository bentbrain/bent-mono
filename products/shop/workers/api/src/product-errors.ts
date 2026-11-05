import { Data } from "effect";

import type { DatabaseFailure } from "./design-errors";

export class InvalidProductInput extends Data.TaggedError("InvalidProductInput")<{
  readonly message: string;
}> {}

export class ProductNotFound extends Data.TaggedError("ProductNotFound")<{
  readonly id: string;
}> {}

export type ProductDomainError =
  | InvalidProductInput
  | ProductNotFound
  | DatabaseFailure;
