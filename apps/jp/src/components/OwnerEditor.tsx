import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import { Selection, type Transaction } from '@tiptap/pm/state';
import { editorExtensions } from '../lib/editor-extensions';
import { z } from 'zod';
import { api } from '../lib/api-client';
import { uploadPostPhoto } from '../lib/upload-post-photo';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { OwnerQueryProvider } from './OwnerQueryProvider';
import { ownerMediaQuery } from '../lib/owner-queries';
import { editorPostSchema, type EditorPost } from '../lib/editor-model';
import { Button, buttonVariants } from './ui/button';
import { Input } from './ui/input';
import { Field, FieldGroup, FieldLabel, FieldError } from './ui/field';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from './ui/alert-dialog';
import { Checkbox } from './ui/checkbox';
import { GalleryOrder } from './GalleryOrder';
import { captureOrder, selectGalleryItem } from '../lib/gallery-order';
import { Badge } from './ui/badge';
import { Separator } from './ui/separator';
import { ShopDesignField } from './ShopDesignField';
import { shopDesignSchema } from '../lib/shop-design';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './ui/tooltip';

const mediaSchema = z.object({
  id: z.string(),
  status: z.string(),
  data: z.object({
    title: z.string(),
    captured_at: z.coerce.date(),
    kind: z.enum(['photo', 'video']),
    asset: z.object({ id: z.string(), url: z.string().optional() }).nullish(),
    poster: z.object({ src: z.string().optional() }).nullish(),
    source_url: z.string().nullish(),
    poster_url: z.string().nullish(),
  }),
});

function EditorForm({
  post,
  onSaved,
}: {
  post: EditorPost;
  onSaved: (post: EditorPost) => void;
}) {
  const savePost = useMutation({
    mutationFn: (input: unknown) => api('/api/trip/posts', input),
  });
  const lifecycle = useMutation({
    mutationFn: ({
      path,
      body,
      method,
    }: {
      path: string;
      body?: unknown;
      method?: string;
    }) => api(path, body, method),
  });
  const [gallery, setGallery] = useState(post.data.gallery);
  const preserveGalleryOrder = useRef(post.data.gallery.length > 0);
  const [shopDesign, setShopDesign] = useState(post.data.shop_design ?? null);
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const deleted = useRef(false);
  const cancelDelete = useRef<HTMLButtonElement>(null);
  const [action, setAction] = useState<'unpublish' | 'delete'>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [dirty, setDirty] = useState(false);
  const editGeneration = useRef(0);
  function markDirty() {
    editGeneration.current++;
    setDirty(true);
    setStatus('');
  }
  const [pickerOpen, setPickerOpen] = useState(false);
  const [inlineUploading, setInlineUploading] = useState(false);
  const [inlineStatus, setInlineStatus] = useState('');
  const inlineBusy = useRef(false);
  const importedSavedImages = useRef({
    postId: post.id,
    assets: new Map<string, Awaited<ReturnType<typeof uploadPostPhoto>>>(),
    revisions: new Map<string, string>(),
    proofs: new Map<string, string>(),
  });
  const media = useQuery({
    ...ownerMediaQuery,
    select: (items) =>
      items
        .filter((item) => item.status === 'published')
        .map((item) => mediaSchema.parse(item)),
    enabled: pickerOpen || gallery.length > 0,
  });
  const items = media.data ?? [];
  const [linkOpen, setLinkOpen] = useState(false);
  const [href, setHref] = useState('');
  const [linkError, setLinkError] = useState('');
  const editor = useEditor({
    extensions: editorExtensions,
    content: post.data.document,
    immediatelyRender: false,
    editorProps: {
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []).filter(
          (file) => file.type.startsWith('image/'),
        );
        if (!files.length) return false;
        event.preventDefault();
        void uploadInlinePhotos(files);
        return true;
      },
      attributes: {
        class:
          'rich-text min-h-[360px] p-4 outline-none [&_p]:mb-4 [&_h2]:mb-4 [&_h2]:text-base [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_a]:underline [&_img]:my-4 [&_img]:max-w-full [&_video]:my-4 [&_video]:max-w-full',
        role: 'textbox',
        'aria-label': 'Post content',
        'aria-multiline': 'true',
      },
    },
    onUpdate: () => {
      markDirty();
    },
  });
  const formatting = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current?.isActive('bold') || false,
      italic: current?.isActive('italic') || false,
    }),
  });
  useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => {
      if ((dirty || inlineBusy.current) && !deleted.current)
        event.preventDefault();
    };
    window.addEventListener('beforeunload', leave);
    return () => {
      window.removeEventListener('beforeunload', leave);
    };
  }, [dirty]);
  async function uploadInlinePhotos(files: File[]) {
    if (!editor) return;
    if (inlineBusy.current || busy.current) {
      setInlineStatus(
        'wait for the current operation, then paste or choose the photo again',
      );
      return;
    }
    let bookmark = editor.state.selection.getBookmark();
    const trackPosition = ({ transaction }: { transaction: Transaction }) => {
      bookmark = bookmark.map(transaction.mapping);
    };
    editor.on('transaction', trackPosition);
    inlineBusy.current = true;
    setInlineUploading(true);
    setInlineStatus('preparing photo');
    const errors: string[] = [];
    for (const file of files) {
      try {
        const asset = await uploadPostPhoto(file, setInlineStatus);
        const node = {
          type: 'image',
          attrs: {
            src: asset.url,
            mediaId: asset.id,
            provider: 'local',
            alt: file.name,
          },
        };
        if (editor.isDestroyed) break;
        const selection = bookmark.resolve(editor.state.doc);
        const { $from } = selection;
        const position =
          $from.depth > 1
            ? $from.after(1)
            : { from: selection.from, to: selection.to };
        const inserted = editor.commands.insertContentAt(position, node, {
          updateSelection: false,
        });
        if (!inserted)
          throw new Error('Could not insert photo. Paste or choose it again.');
        // Text bookmarks can stay in the paragraph preceding a block image.
        // Advance explicitly so a clipboard batch retains its original order.
        editor.state.doc.descendants((child, position) => {
          if (child.type.name === 'image' && child.attrs.mediaId === asset.id) {
            bookmark = Selection.near(
              editor.state.doc.resolve(position + child.nodeSize),
            ).getBookmark();
            return false;
          }
        });
        setInlineStatus('');
        setPickerOpen(false);
      } catch (error) {
        errors.push(
          error instanceof Error ? error.message : 'Photo upload failed',
        );
      }
    }
    editor.off('transaction', trackPosition);
    inlineBusy.current = false;
    setInlineUploading(false);
    setInlineStatus(errors.join('\n'));
  }
  async function importSavedImages() {
    if (!editor || !post.id) return;
    if (importedSavedImages.current.postId !== post.id) {
      importedSavedImages.current.postId = post.id;
      importedSavedImages.current.assets.clear();
      importedSavedImages.current.revisions.clear();
      importedSavedImages.current.proofs.clear();
    }
    for (const [source, revisionId] of Object.entries(
      post.imageSourceRevisions,
    ))
      importedSavedImages.current.revisions.set(source, revisionId);
    for (const [source, proof] of Object.entries(post.imageSourceProofs))
      importedSavedImages.current.proofs.set(source, proof);
    const sources = new Set<string>();
    editor.state.doc.descendants((node) => {
      const source: unknown = node.attrs.mediaId;
      if (
        node.type.name === 'image' &&
        typeof source === 'string' &&
        /^https?:\/\//i.test(source)
      )
        sources.add(source);
    });
    for (const source of sources) {
      // Undo may restore a URL from an older document revision. Reuse the
      // already authorized upload instead of fetching that historical URL again.
      let asset = importedSavedImages.current.assets.get(source);
      if (!asset) {
        setStatus('importing saved image');
        const response = await fetch('/api/trip/post-image-source', {
          method: 'POST',
          headers: {
            'X-EmDash-Request': '1',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            id: post.id,
            revision: post.revision,
            source,
            sourceProof: importedSavedImages.current.proofs.get(source),
            sourceRevision: importedSavedImages.current.proofs.has(source)
              ? undefined
              : importedSavedImages.current.revisions.get(source),
          }),
          signal: AbortSignal.timeout(45_000),
        });
        if (!response.ok) {
          if (response.status === 409)
            throw new Error(
              'Post changed. Reload before importing its images.',
            );
          if (response.status === 401)
            throw new Error('Sign in again before importing saved images.');
          throw new Error('Could not import the saved image. Try again.');
        }
        const blob = await response.blob();
        asset = await uploadPostPhoto(
          new File([blob], 'saved-image', { type: blob.type }),
          setStatus,
        );
        importedSavedImages.current.assets.set(source, asset);
      }
      if (editor.isDestroyed) throw new Error('Editor closed before saving');
      const transaction = editor.state.tr;
      editor.state.doc.descendants((node, position) => {
        if (node.type.name === 'image' && node.attrs.mediaId === source)
          transaction.setNodeMarkup(position, undefined, {
            ...node.attrs,
            src: asset.url,
            mediaId: asset.id,
            provider: 'local',
          });
      });
      // Reconciliation is part of this save, not a newer owner edit. Keep it
      // dirty until the save succeeds without advancing the owner edit counter.
      editor.view.dispatch(
        transaction
          .setMeta('preventUpdate', true)
          .setMeta('addToHistory', false),
      );
      setDirty(true);
    }
  }
  async function save(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || busy.current || inlineBusy.current) return;
    if (shopDesign && !shopDesignSchema.safeParse(shopDesign).success) {
      setStatus('use a product link from shop.bent.build');
      return;
    }
    const values = new FormData(event.currentTarget),
      submitted = event.nativeEvent;
    const publish =
      submitted.submitter instanceof HTMLButtonElement &&
      submitted.submitter.dataset.publish === 'true';
    busy.current = true;
    setSaving(true);
    const submittedGeneration = editGeneration.current;
    try {
      await importSavedImages();
      const result = z
        .object({
          post: editorPostSchema,
          publicationError: z.string().optional(),
        })
        .parse(
          await savePost.mutateAsync({
            id: post.id || undefined,
            revision: post.revision || undefined,
            title: values.get('title'),
            day: values.get('day'),
            place: values.get('place'),
            gallery,
            shop_design: shopDesign,
            document: editor.getJSON(),
            publish,
          }),
        );
      const saved = result.post;
      const newerEdits = editGeneration.current !== submittedGeneration;
      setDirty(newerEdits);
      onSaved(saved);
      setStatus(
        [
          result.publicationError || (publish ? 'published' : 'draft saved'),
          ...(newerEdits ? ['newer edits unsaved'] : []),
        ].join('\n'),
      );
      if (!post.id) history.replaceState(null, '', `/owner/posts/${saved.id}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Save failed');
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }
  async function mutatePost(nextAction: 'unpublish' | 'delete') {
    if (!post.id || busy.current) return;
    busy.current = true;
    setSaving(true);
    setAction(nextAction);
    setDeleteError('');
    setStatus('');
    const submittedGeneration = editGeneration.current;
    const path = `/_emdash/api/content/posts/${encodeURIComponent(post.id)}`;
    try {
      if (nextAction === 'unpublish') {
        const result = z
          .object({
            data: z.object({
              _rev: z.string(),
              item: z.object({ status: z.string() }),
            }),
          })
          .parse(
            await lifecycle.mutateAsync({
              path: `${path}/unpublish`,
              body: { _rev: post.revision },
            }),
          );
        onSaved({
          ...post,
          revision: result.data._rev,
          status: result.data.item.status,
        });
        setStatus(
          [
            'unpublished',
            ...(dirty || editGeneration.current !== submittedGeneration
              ? ['unsaved edits']
              : []),
          ].join('\n'),
        );
      } else {
        await lifecycle.mutateAsync({ path, method: 'DELETE' });
        deleted.current = true;
        window.location.assign('/owner');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Request failed';
      if (nextAction === 'delete') setDeleteError(message);
      else setStatus(message);
    } finally {
      busy.current = false;
      setSaving(false);
      setAction(undefined);
    }
  }
  return (
    <form
      onSubmit={(event) => {
        void save(event);
      }}
      onChange={() => {
        markDirty();
      }}
      className="space-y-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1>edit post</h1>
        <Badge variant="outline">{post.status}</Badge>
      </div>
      <div className="grid grid-cols-1 gap-6 min-[901px]:grid-cols-[minmax(0,1fr)_280px]">
        <div className="space-y-4">
          <Field>
            <FieldLabel htmlFor="post-title">title</FieldLabel>
            <Input
              id="post-title"
              name="title"
              defaultValue={post.data.title}
              required
              maxLength={200}
            />
          </Field>
          <div className="border" data-feedback-id="rich-text-editor">
            <TooltipProvider>
              <div className="flex flex-wrap items-center gap-2 border-b p-2">
                <ToggleGroup
                  multiple
                  value={[
                    ...(formatting?.bold ? ['bold'] : []),
                    ...(formatting?.italic ? ['italic'] : []),
                  ]}
                  variant="outline"
                >
                  <ToggleGroupItem
                    value="bold"
                    aria-label="Bold"
                    onClick={() => editor?.chain().focus().toggleBold().run()}
                  >
                    B
                  </ToggleGroupItem>
                  <ToggleGroupItem
                    value="italic"
                    aria-label="Italic"
                    onClick={() => editor?.chain().focus().toggleItalic().run()}
                  >
                    I
                  </ToggleGroupItem>
                </ToggleGroup>
                <Separator orientation="vertical" className="h-6" />
                <Tooltip>
                  <TooltipTrigger
                    render={<Button type="button" size="sm" />}
                    onClick={() =>
                      editor?.chain().focus().toggleHeading({ level: 2 }).run()
                    }
                  >
                    H2
                  </TooltipTrigger>
                  <TooltipContent>heading</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={<Button type="button" size="sm" />}
                    onClick={() =>
                      editor?.chain().focus().toggleBulletList().run()
                    }
                  >
                    LIST
                  </TooltipTrigger>
                  <TooltipContent>bullet list</TooltipContent>
                </Tooltip>
                <Dialog
                  open={linkOpen}
                  onOpenChange={(open) => {
                    setLinkOpen(open);
                    setLinkError('');
                    if (open) {
                      const current: unknown =
                        editor?.getAttributes('link').href;
                      setHref(typeof current === 'string' ? current : '');
                    }
                  }}
                >
                  <DialogTrigger render={<Button type="button" size="sm" />}>
                    LINK
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>link</DialogTitle>
                    </DialogHeader>
                    <Field>
                      <FieldLabel htmlFor="post-link">url</FieldLabel>
                      <Input
                        id="post-link"
                        type="url"
                        value={href}
                        onChange={(event) => {
                          setHref(event.target.value);
                        }}
                        aria-invalid={Boolean(linkError)}
                      />
                      {linkError && <FieldError>{linkError}</FieldError>}
                    </Field>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="default"
                        onClick={() => {
                          const parsed = z.url().safeParse(href);
                          if (
                            !parsed.success ||
                            !['http:', 'https:'].includes(
                              new URL(parsed.data).protocol,
                            )
                          ) {
                            setLinkError('url required');
                            return;
                          }
                          editor
                            ?.chain()
                            .focus()
                            .extendMarkRange('link')
                            .setLink({ href: parsed.data })
                            .run();
                          setLinkOpen(false);
                        }}
                      >
                        APPLY
                      </Button>
                      <Button
                        type="button"
                        onClick={() => {
                          editor?.chain().focus().unsetLink().run();
                          setLinkOpen(false);
                        }}
                      >
                        REMOVE
                      </Button>
                    </div>
                  </DialogContent>
                </Dialog>
                <Dialog
                  open={pickerOpen}
                  onOpenChange={(open) => {
                    if (!inlineBusy.current) setPickerOpen(open);
                  }}
                >
                  <DialogTrigger render={<Button type="button" size="sm" />}>
                    + MEDIA
                  </DialogTrigger>
                  <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
                    <DialogHeader>
                      <DialogTitle>media</DialogTitle>
                    </DialogHeader>
                    <Field>
                      <FieldLabel htmlFor="post-inline-photo">
                        post-only photo
                      </FieldLabel>
                      <Input
                        id="post-inline-photo"
                        type="file"
                        accept="image/*,.heic,.heif"
                        disabled={inlineUploading || saving}
                        onChange={(event) => {
                          const file = event.currentTarget.files?.[0];
                          event.currentTarget.value = '';
                          if (file) void uploadInlinePhotos([file]);
                        }}
                      />
                      <p className="text-xs">
                        inline only · stays out of the trip gallery
                      </p>
                      <p
                        role="status"
                        className="whitespace-pre-wrap empty:hidden"
                      >
                        {inlineStatus}
                      </p>
                    </Field>
                    <Separator />
                    <a href="/owner/media" className="underline">
                      UPLOAD / EDIT MEDIA →
                    </a>
                    <p role="status" className="empty:hidden">
                      {media.isFetching && !media.data
                        ? 'loading media'
                        : media.error?.message}
                    </p>
                    <div className="trip-gallery-field">
                      <div className="trip-gallery-options grid grid-cols-2 gap-3 sm:grid-cols-3">
                        {captureOrder(items, 'desc').map((item) => (
                          <div key={item.id} className="space-y-2">
                            <img
                              src={
                                item.data.poster?.src ||
                                item.data.poster_url ||
                                item.data.asset?.url ||
                                item.data.source_url ||
                                ''
                              }
                              alt={item.data.title}
                              className="aspect-[1.15] w-full object-cover"
                            />
                            <Field orientation="horizontal">
                              <Checkbox
                                id={`post-gallery-${item.id}`}
                                checked={gallery.includes(item.id)}
                                onCheckedChange={(checked) => {
                                  setGallery((current) =>
                                    checked
                                      ? selectGalleryItem(
                                          current,
                                          item.id,
                                          items,
                                          preserveGalleryOrder.current,
                                        )
                                      : current.filter((id) => id !== item.id),
                                  );
                                  if (!checked && gallery.length === 1)
                                    preserveGalleryOrder.current = false;
                                  markDirty();
                                }}
                              />
                              <FieldLabel htmlFor={`post-gallery-${item.id}`}>
                                gallery
                              </FieldLabel>
                            </Field>
                            <Button
                              type="button"
                              size="sm"
                              disabled={!item.data.asset || inlineUploading}
                              onClick={() => {
                                if (!editor || !item.data.asset) return;
                                const mediaNode = {
                                  type:
                                    item.data.kind === 'video'
                                      ? 'videoBlock'
                                      : 'image',
                                  attrs: {
                                    src:
                                      item.data.source_url ||
                                      item.data.asset.url,
                                    mediaId: item.data.asset.id,
                                    provider: 'local',
                                    alt: item.data.title,
                                  },
                                };
                                const { $from } = editor.state.selection;
                                const chain = editor.chain().focus();
                                if ($from.depth > 1)
                                  chain
                                    .insertContentAt($from.after(1), mediaNode)
                                    .run();
                                else chain.insertContent(mediaNode).run();
                                setPickerOpen(false);
                              }}
                            >
                              INSERT IN POST
                            </Button>
                          </div>
                        ))}
                      </div>
                    </div>
                  </DialogContent>
                </Dialog>
              </div>
            </TooltipProvider>
            <EditorContent editor={editor} />
            <p
              role="status"
              className="whitespace-pre-wrap px-4 pb-4 empty:hidden"
            >
              {pickerOpen ? '' : inlineStatus}
            </p>
          </div>
          <GalleryOrder
            selected={gallery}
            items={items}
            onChange={(ids) => {
              preserveGalleryOrder.current = true;
              setGallery(ids);
              markDirty();
            }}
          />
        </div>
        <FieldGroup className="gap-4">
          <Field>
            <FieldLabel htmlFor="post-day">day</FieldLabel>
            <Input
              id="post-day"
              name="day"
              type="date"
              defaultValue={post.data.day}
              required
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="post-place">place</FieldLabel>
            <Input
              id="post-place"
              name="place"
              defaultValue={post.data.place}
            />
          </Field>
          <Separator />
          <ShopDesignField
            value={shopDesign}
            onChange={(value) => {
              setShopDesign(value);
              markDirty();
            }}
          />
          <Separator />
          <Button type="submit" disabled={saving || inlineUploading || !editor}>
            SAVE DRAFT
          </Button>
          <Button
            type="submit"
            data-publish="true"
            variant="default"
            disabled={saving || inlineUploading || !editor}
          >
            PUBLISH
          </Button>
          {post.id && post.status === 'published' && (
            <a
              href={`/posts/${post.id}`}
              className={buttonVariants({ variant: 'link' })}
            >
              VIEW POST
            </a>
          )}
          {post.id && (
            <>
              <Separator />
              {(post.status === 'published' || post.status === 'scheduled') && (
                <Button
                  type="button"
                  disabled={saving || inlineUploading}
                  onClick={() => {
                    void mutatePost('unpublish');
                  }}
                >
                  {action === 'unpublish' ? 'UNPUBLISHING' : 'UNPUBLISH'}
                </Button>
              )}
              <AlertDialog
                open={deleteOpen}
                onOpenChange={(open, details) => {
                  if (busy.current) {
                    details.cancel();
                    return;
                  }
                  setDeleteOpen(open);
                  setDeleteError('');
                }}
              >
                <AlertDialogTrigger
                  render={
                    <Button
                      type="button"
                      disabled={saving || inlineUploading}
                    />
                  }
                >
                  DELETE POST
                </AlertDialogTrigger>
                <AlertDialogContent initialFocus={cancelDelete}>
                  <AlertDialogHeader>
                    <AlertDialogTitle>delete post?</AlertDialogTitle>
                    <AlertDialogDescription>
                      moves this post to trash and removes it from the blog.
                      media stays in the library.
                      {dirty && ' unsaved edits will be discarded.'}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  {deleteError && <p role="alert">{deleteError}</p>}
                  <AlertDialogFooter>
                    <AlertDialogCancel
                      ref={cancelDelete}
                      type="button"
                      disabled={saving || inlineUploading}
                    >
                      CANCEL
                    </AlertDialogCancel>
                    <AlertDialogAction
                      type="button"
                      variant="default"
                      disabled={saving || inlineUploading}
                      onClick={() => {
                        void mutatePost('delete');
                      }}
                    >
                      {action === 'delete' ? 'DELETING' : 'DELETE'}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          )}
          <p className="whitespace-pre-wrap empty:hidden" role="status">
            {status}
          </p>
        </FieldGroup>
      </div>
    </form>
  );
}
export function OwnerEditor(props: { id?: string; day: string }) {
  return (
    <OwnerQueryProvider>
      <PostEditor {...props} />
    </OwnerQueryProvider>
  );
}
function PostEditor({ id, day }: { id?: string; day: string }) {
  const client = useQueryClient();
  const queryKey = ['owner', 'post', id || 'new', day];
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) =>
      id
        ? editorPostSchema.parse(
            await api(
              `/api/trip/posts?id=${encodeURIComponent(id)}`,
              undefined,
              'GET',
              signal,
            ),
          )
        : editorPostSchema.parse({
            id: '',
            revision: '',
            status: 'draft',
            data: {
              title: '',
              day,
              place: '',
              gallery: [],
              document: { type: 'doc', content: [{ type: 'paragraph' }] },
            },
          }),
    staleTime: Infinity,
  });
  return query.data ? (
    <EditorForm
      post={query.data}
      onSaved={(post) => {
        client.setQueryData(queryKey, post);
      }}
    />
  ) : (
    <div className="space-y-3">
      <p role="status">{query.error?.message || 'loading'}</p>
      {query.isError && id && (
        <a
          className={buttonVariants()}
          href={`/_emdash/admin/content/posts/${encodeURIComponent(id)}`}
        >
          OPEN IN CMS
        </a>
      )}
    </div>
  );
}
