import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { savedImageProofs } from '../../../lib/saved-image-recovery';
import {
  legacyImageReferences,
  savedImageRevisions,
} from '../../../lib/saved-post-image';
import { z } from 'zod';
import { getSchema } from '@tiptap/core';
import { editorExtensions } from '../../../lib/editor-extensions';
import { editorPostSchema, postInputSchema } from '../../../lib/editor-model';
import {
  fromEditorDocument,
  contentForSave,
  preservesContent,
  toEditorDocument,
} from '../../../lib/editor-conversion';
import { publishItem, savedItemSchema } from '../../../lib/publish';
import { shopDesignSchema } from '../../../lib/shop-design';
import { tripStartDayFromContent } from '../../../lib/content';
import { correctTripTitle, isNumberedTripTitle } from '../../../lib/trip-days';
async function editorTitle(
  cms: App.Locals['emdash'],
  day: string,
  title: string,
) {
  if (!isNumberedTripTitle(title)) return title;
  return correctTripTitle(day, await tripStartDayFromContent(cms), title);
}
const portableBlocks = z.array(
  z.looseObject({ _type: z.string(), _key: z.string() }),
);
const postImageState = z.object({
  id: z.string(),
  createdAt: z.string(),
  data: z.record(z.string(), z.unknown()),
  draftRevisionId: z.string().nullish(),
  liveRevisionId: z.string().nullish(),
});
export const GET: APIRoute = async ({ locals, url }) => {
  if (!locals.user || locals.user.role < 50)
    return Response.json({ error: 'Sign in required' }, { status: 401 });
  const id = url.searchParams.get('id');
  if (!id) return Response.json({ error: 'Post required' }, { status: 400 });
  const result = await locals.emdash.handleContentGet('posts', id);
  if (!result.success || !result.data)
    return Response.json({ error: 'Post not found' }, { status: 404 });
  const data = z
    .object({
      title: z.string(),
      day: z.string(),
      place: z.string().nullish(),
      gallery: z.array(z.string()).nullish(),
      shop_design: shopDesignSchema.nullish(),
      content: portableBlocks.nullish(),
    })
    .parse(result.data.item.data);
  let document;
  try {
    document = toEditorDocument(data.content || []);
    const reconstructed = getSchema(editorExtensions).nodeFromJSON(document);
    reconstructed.check();
    document = editorPostSchema.shape.data.shape.document.parse(
      reconstructed.toJSON(),
    );
    if (
      data.content?.length &&
      !preservesContent(data.content, fromEditorDocument(document))
    )
      throw new Error('Lossy conversion');
  } catch {
    return Response.json(
      {
        error:
          'This post uses content that needs the native CMS editor. Open it there to keep all blocks.',
      },
      { status: 422 },
    );
  }
  const imageState = postImageState.parse(result.data.item);
  return Response.json({
    id,
    revision: result.data._rev,
    imageSourceRevisions: savedImageRevisions(
      data.content,
      imageState.draftRevisionId ?? imageState.liveRevisionId,
    ),
    imageSourceProofs: await savedImageProofs(
      legacyImageReferences(data.content),
      {
        origin: url.origin,
        postId: id,
        createdAt: imageState.createdAt,
        principalId: locals.user.id,
      },
      env.EMDASH_ENCRYPTION_KEY,
    ),
    status: result.data.item.status,
    data: {
      title: await editorTitle(locals.emdash, data.day, data.title),
      day: data.day,
      place: data.place || '',
      gallery: data.gallery || [],
      shop_design: data.shop_design ?? null,
      document,
    },
  });
};
export const POST: APIRoute = async ({ locals, request, url }) => {
  const input = postInputSchema.safeParse(await request.json());
  if (!input.success || !locals.user)
    return Response.json({ error: 'Choose a title and day' }, { status: 400 });
  const { id, revision, document, publish, ...fields } = input.data;
  if (id && !revision)
    return Response.json({ error: 'Post revision required' }, { status: 400 });
  let content;
  try {
    content = contentForSave(document);
  } catch {
    return Response.json(
      {
        error:
          'This layout cannot be saved safely. Move media outside lists and quotes, or use the CMS editor.',
      },
      { status: 400 },
    );
  }
  let previousImageSources: Record<string, string> = {};
  let previousImageProofs: Record<string, string> = {};
  if (id) {
    const previous = await locals.emdash.handleContentGet('posts', id);
    if (!previous.success || !previous.data)
      return Response.json({ error: 'Post not found' }, { status: 404 });
    if (previous.data._rev !== revision)
      return Response.json(
        { error: 'Post changed. Reload before saving.' },
        { status: 409 },
      );
    const item = postImageState.parse(previous.data.item);
    previousImageSources = savedImageRevisions(
      item.data.content,
      item.draftRevisionId ?? item.liveRevisionId,
    );
    // Attest only the actual saved state before replacing it. No image fetch,
    // extra history entry or retention change is needed for a deleted source.
    previousImageProofs = await savedImageProofs(
      legacyImageReferences(item.data.content),
      {
        origin: url.origin,
        postId: item.id,
        createdAt: item.createdAt,
        principalId: locals.user.id,
      },
      env.EMDASH_ENCRYPTION_KEY,
    );
  }
  const actor = { id: locals.user.id, role: locals.user.role };
  const data = { ...fields, content };
  const saved = id
    ? await locals.emdash.handleContentUpdate('posts', id, {
        data,
        _rev: revision,
        actor,
      })
    : await locals.emdash.handleContentCreate('posts', {
        data,
        slug: `post-${fields.day}-${crypto.randomUUID()}`,
        actor,
      });
  if (!saved.success) return Response.json(saved, { status: 409 });
  const postId = id || savedItemSchema.parse(saved.data).item.id;
  let publicationError: string | undefined;
  if (publish) {
    const result = await publishItem(locals.emdash, 'posts', postId, actor);
    if (!result.success)
      publicationError =
        result.error?.message || 'Post saved, publication rejected';
  }
  const current = await locals.emdash.handleContentGet('posts', postId);
  if (!current.success || !current.data)
    return Response.json(current, { status: 500 });
  const currentImageState = postImageState.parse(current.data.item);
  return Response.json({
    post: {
      id: postId,
      revision: current.data._rev,
      imageSourceRevisions: {
        ...previousImageSources,
        ...savedImageRevisions(
          currentImageState.data.content,
          currentImageState.draftRevisionId ?? currentImageState.liveRevisionId,
        ),
      },
      imageSourceProofs: {
        ...previousImageProofs,
        ...(await savedImageProofs(
          legacyImageReferences(currentImageState.data.content),
          {
            origin: url.origin,
            postId,
            createdAt: currentImageState.createdAt,
            principalId: locals.user.id,
          },
          env.EMDASH_ENCRYPTION_KEY,
        )),
      },
      status: current.data.item.status,
      data: {
        ...fields,
        title: await editorTitle(locals.emdash, fields.day, fields.title),
        document,
      },
    },
    publicationError,
  });
};
