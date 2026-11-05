import { z } from 'zod';
const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:4321';
const target = new URL(base);
if (
  target.protocol !== 'http:' ||
  !['localhost', '127.0.0.1'].includes(target.hostname)
)
  throw new Error('Demo seeds only run on local development servers.');
const login = await fetch(`${base}/_emdash/api/auth/dev-bypass`, {
  redirect: 'manual',
});
const cookie = login.headers.get('set-cookie')?.split(';')[0];
await login.text();
if (!cookie) throw new Error('Start the local development server first.');
const itemSchema = z.object({
  success: z.literal(true),
  data: z.object({ item: z.object({ id: z.string() }) }),
});
async function create(
  collection: string,
  slug: string,
  data: Record<string, unknown>,
) {
  const headers = {
    Cookie: cookie || '',
    'X-EmDash-Request': '1',
    'Content-Type': 'application/json',
    Origin: base,
  };
  const list = z
    .object({
      data: z.object({
        items: z.array(
          z.object({ id: z.string(), slug: z.string().nullable() }),
        ),
      }),
    })
    .parse(
      await (
        await fetch(`${base}/_emdash/api/content/${collection}?limit=100`, {
          headers,
        })
      ).json(),
    );
  const existing = list.data.items.find((item) => item.slug === slug);
  if (existing) {
    const current = z
      .object({ data: z.object({ _rev: z.string() }) })
      .parse(
        await (
          await fetch(
            `${base}/_emdash/api/content/${collection}/${existing.id}`,
            { headers },
          )
        ).json(),
      );
    const published = await fetch(
      `${base}/_emdash/api/content/${collection}/${existing.id}/publish`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ _rev: current.data._rev }),
      },
    );
    if (!published.ok) throw new Error(await published.text());
    return existing.id;
  }
  const response = await fetch(`${base}/_emdash/api/content/${collection}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ slug, data }),
  });
  const body: unknown = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(body));
  const id = itemSchema.parse(body).data.item.id;
  const current = z.object({ data: z.object({ _rev: z.string() }) }).parse(
    await (
      await fetch(`${base}/_emdash/api/content/${collection}/${id}`, {
        headers,
      })
    ).json(),
  );
  const published = await fetch(
    `${base}/_emdash/api/content/${collection}/${id}/publish`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ _rev: current.data._rev }),
    },
  );
  if (!published.ok) throw new Error(await published.text());
  return id;
}
const ids: string[] = [];
for (const [index, asset] of [
  'tokyo',
  'japan',
  'kyoto',
  'tokyo',
  'kyoto',
  'japan',
  'tokyo',
  'japan',
  'kyoto',
].entries()) {
  const place = asset === 'kyoto' ? 'kyoto' : 'tokyo',
    video = [3, 5].includes(index);
  ids.push(
    await create('media_items', `demo-${String(index)}`, {
      title: `${place} / ${String(index + 1)}`,
      kind: video ? 'video' : 'photo',
      captured_at: `2026-10-${place === 'kyoto' ? '14' : '15'}T19:42:00+09:00`,
      latitude: place === 'kyoto' ? 35.0116 : 35.6895,
      longitude: place === 'kyoto' ? 135.7681 : 139.6917,
      place,
      categories: [
        asset === 'japan'
          ? 'food'
          : asset === 'kyoto'
            ? 'landscape'
            : 'shopping',
      ],
      duration: video ? 8 : null,
      source_url: video ? '/demo/sample.mp4' : `/demo/${asset}.jpg`,
      poster_url: `/demo/${asset}.jpg`,
      demo: true,
    }),
  );
}
const block = (text: string) => [
  {
    _type: 'block',
    _key: crypto.randomUUID(),
    style: 'normal',
    children: [{ _type: 'span', _key: crypto.randomUUID(), text, marks: [] }],
    markDefs: [],
  },
];
await create('posts', 'tokyo-after-dark', {
  title: 'tokyo',
  place: 'tokyo',
  day: '2026-10-15',
  content: block(
    'Spent the evening walking through Shinjuku. Stopped for dinner, then kept walking.',
  ),
  gallery: [ids[0], ids[1], ids[3]],
  demo: true,
});
await create('posts', 'kyoto', {
  title: 'kyoto',
  place: 'kyoto',
  day: '2026-10-14',
  content: block('An afternoon in Higashiyama.'),
  gallery: [ids[2], ids[4], ids[8]],
  demo: true,
});
await create('posts', 'arriving', {
  title: 'tokyo',
  place: 'tokyo',
  day: '2026-10-13',
  content: block('Checked in, then went for a walk.'),
  gallery: [ids[6], ids[5], ids[7]],
  demo: true,
});
for (const [day, count] of [
  ['2026-10-13', 20],
  ['2026-10-14', 4],
  ['2026-10-15', 3],
])
  await create('beers', String(day), {
    title: String(day),
    day,
    count,
    demo: true,
  });
console.log(
  'Created 3 demo posts, 9 media items and 3 beer entries in local D1.',
);
