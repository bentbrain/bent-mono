import { Data } from "effect";

export class InvalidDesignInput extends Data.TaggedError("InvalidDesignInput")<{
  readonly message: string;
}> {}

export class DesignNotFound extends Data.TaggedError("DesignNotFound")<{
  readonly id: string;
}> {}

export class DatabaseFailure extends Data.TaggedError("DatabaseFailure")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export class ArtworkStorageFailure extends Data.TaggedError("ArtworkStorageFailure")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export type DesignDomainError =
  | InvalidDesignInput
  | DesignNotFound
  | DatabaseFailure
  | ArtworkStorageFailure;
