export async function rateLimitAllows(limiter: RateLimit, key: string) {
  return (await limiter.limit({ key })).success;
}
