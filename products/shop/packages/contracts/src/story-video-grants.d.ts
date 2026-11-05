export interface StoryVideoGrant {
  readonly jobId: string;
  readonly attempt: number;
  readonly expiresAt: number;
}

export function isStoryVideoJobId(value: unknown): value is string;

export function createStoryVideoGrant(secret: string, jobId: string, attempt: number, now?: number): Promise<string>;

export function verifyStoryVideoGrant(
  secret: string,
  token: string,
  jobId: string,
  now?: number,
  failureGraceMs?: number,
): Promise<StoryVideoGrant | undefined>;
