import { Extension, Mark, Node, mergeAttributes } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Code from '@tiptap/extension-code';
import Image from '@tiptap/extension-image';
import { z } from 'zod';
import { InstagramProfilePaste } from './instagram-profile-paste';

// Keep EmDash's span identity alongside code while excluding visual marks.
const TripInlineCode = Code.extend({
  excludes: 'bold italic strike underline link code',
});

const TripImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      mediaId: { default: null, rendered: false },
      provider: { default: 'local', rendered: false },
      ...Object.fromEntries(
        [
          'caption',
          'width',
          'height',
          'displayWidth',
          'displayHeight',
          'alignment',
          'link',
        ].map((name) => [name, { default: null, rendered: false }]),
      ),
    };
  },
});
const TripVideo = Node.create({
  name: 'videoBlock',
  group: 'block',
  atom: true,
  addAttributes() {
    return {
      src: { default: '' },
      mediaId: { default: null },
      provider: { default: 'local' },
      caption: { default: '', rendered: false },
      width: { default: null },
      height: { default: null },
    };
  },
  parseHTML() {
    return [{ tag: 'video[src]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      'video',
      mergeAttributes(HTMLAttributes, { controls: '', playsinline: '' }),
    ];
  },
});
const TripGallery = Node.create({
  name: 'gallery',
  group: 'block',
  atom: true,
  addAttributes() {
    return {
      images: { default: [], rendered: false },
      columns: { default: null, rendered: false },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-trip-gallery]' }];
  },
  renderHTML({ node }) {
    const images = z
      .array(
        z.object({
          asset: z.object({ url: z.string().optional() }),
          alt: z.string().optional(),
        }),
      )
      .safeParse(node.attrs.images);
    const children: ['img', { src: string; alt: string }][] = images.success
      ? images.data.map((image) => [
          'img',
          { src: image.asset.url || '', alt: image.alt || '' },
        ])
      : [];
    return [
      'div',
      { 'data-trip-gallery': '', class: 'grid grid-cols-2 gap-2' },
      ...children,
    ];
  },
});
// EmDash converter identity attributes stay in the document, without importing
// its server entrypoint into the browser editor.
const ContentIdentity = Extension.create({
  name: 'tripContentIdentity',
  addGlobalAttributes() {
    return [
      {
        types: [
          'paragraph',
          'heading',
          'blockquote',
          'codeBlock',
          'image',
          'videoBlock',
          'horizontalRule',
          'gallery',
          'emdashPortableTextBlock',
        ],
        attributes: {
          emdashPortableTextKey: { default: null, rendered: false },
          tripEmptySpanKey: { default: null, rendered: false },
        },
      },
    ];
  },
});
const SpanIdentity = Mark.create({
  name: 'emdashPortableTextSpan',
  inclusive: false,
  spanning: false,
  addAttributes() {
    return {
      key: { default: null, rendered: false },
      markDefs: { default: [], rendered: false },
    };
  },
  parseHTML() {
    return [];
  },
  renderHTML() {
    return ['span', 0];
  },
});
const SavedBlock = Node.create({
  name: 'emdashPortableTextBlock',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return { emdashPortableTextBlock: { default: null, rendered: false } };
  },
  parseHTML() {
    return [{ tag: 'div[data-saved-block]' }];
  },
  renderHTML({ node }) {
    const value = z
      .object({ _type: z.string() })
      .safeParse(node.attrs.emdashPortableTextBlock);
    const label = value.success ? `${value.data._type} block` : 'saved block';
    return [
      'div',
      {
        'data-saved-block': '',
        contenteditable: 'false',
        class: 'my-4 border p-3 text-xs',
      },
      label,
    ];
  },
});
export const editorExtensions = [
  StarterKit.configure({ code: false }),
  InstagramProfilePaste,
  TripInlineCode,
  TripImage,
  TripVideo,
  TripGallery,
  ContentIdentity,
  SpanIdentity,
  SavedBlock,
];
