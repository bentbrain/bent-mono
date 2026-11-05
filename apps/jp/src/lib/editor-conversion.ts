import { z } from 'zod';
import { getSchema } from '@tiptap/core';
import { editorExtensions } from './editor-extensions';
import { editorPostSchema } from './editor-model';
import {
  portableTextToProsemirror,
  prosemirrorToPortableText,
  type ProseMirrorDocument,
  type ProseMirrorNode,
} from 'emdash';

const array = z.array(z.unknown());
const record = z.record(z.string(), z.unknown());
const emptyTextBlock = z.object({
  _type: z.literal('block'),
  _key: z.string(),
  children: z.tuple([
    z.object({
      _type: z.literal('span'),
      _key: z.string(),
      text: z.literal(''),
      marks: z.array(z.string()).max(0).optional(),
    }),
  ]),
});

function visitNodes(
  nodes: ProseMirrorNode[],
  visit: (node: ProseMirrorNode) => void,
) {
  for (const node of nodes) {
    visit(node);
    if (node.content) visitNodes(node.content, visit);
  }
}

// ProseMirror cannot contain empty text nodes. Retain the single empty span's
// key on its paragraph instead, and restore it only while that paragraph is empty.
export function toEditorDocument(
  blocks: Parameters<typeof portableTextToProsemirror>[0],
) {
  const emptyKeys = new Map<string, string>();
  for (const block of blocks) {
    const empty = emptyTextBlock.safeParse(block);
    if (empty.success)
      emptyKeys.set(empty.data._key, empty.data.children[0]._key);
  }
  const document = portableTextToProsemirror(blocks, {
    preserveIdentity: true,
  });
  visitNodes(document.content, (node) => {
    const key = node.attrs?.emdashPortableTextKey;
    if (typeof key !== 'string' || node.content?.length) return;
    const spanKey = emptyKeys.get(key);
    if (spanKey) node.attrs = { ...node.attrs, tripEmptySpanKey: spanKey };
  });
  return document;
}

export function fromEditorDocument(document: ProseMirrorDocument) {
  function retainEmptyParagraph(node: ProseMirrorNode): ProseMirrorNode {
    return {
      ...node,
      ...(node.type === 'paragraph' &&
      !node.content?.length &&
      !node.attrs?.emdashPortableTextKey
        ? {
            attrs: {
              ...node.attrs,
              emdashPortableTextKey: crypto.randomUUID(),
            },
          }
        : {}),
      ...(node.content
        ? { content: node.content.map(retainEmptyParagraph) }
        : {}),
    };
  }
  // EmDash omits an unkeyed trailing paragraph, including one inserted after
  // an image. Give empty paragraphs identities before serializing them.
  const retained = {
    ...document,
    content: document.content.map(retainEmptyParagraph),
  };
  const emptyKeys = new Map<string, string>();
  visitNodes(retained.content, (node) => {
    const key = node.attrs?.emdashPortableTextKey;
    const spanKey = node.attrs?.tripEmptySpanKey;
    if (
      !node.content?.length &&
      typeof key === 'string' &&
      typeof spanKey === 'string'
    )
      emptyKeys.set(key, spanKey);
  });
  return prosemirrorToPortableText(retained).map((block) => {
    const empty = emptyTextBlock.safeParse(block);
    const spanKey = emptyKeys.get(block._key);
    if (!empty.success || !spanKey) return block;
    return {
      ...block,
      children: [{ ...empty.data.children[0], _key: spanKey }],
    };
  });
}

function editorMeaning(node: ProseMirrorNode): unknown {
  const attrs = Object.fromEntries(
    Object.entries(node.attrs || {}).filter(
      ([key, value]) =>
        !['emdashPortableTextKey', 'tripEmptySpanKey'].includes(key) &&
        value !== null &&
        value !== undefined &&
        !(value === '' && ['alt', 'title', 'caption'].includes(key)),
    ),
  );
  const marks = (node.marks || [])
    .filter((mark) => mark.type !== 'emdashPortableTextSpan')
    .map((mark) => editorMeaning(mark))
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  return {
    type: node.type,
    ...(node.text !== undefined ? { text: node.text } : {}),
    ...(Object.keys(attrs).length ? { attrs } : {}),
    ...(marks.length ? { marks } : {}),
    ...(node.content?.length
      ? { content: node.content.map(editorMeaning) }
      : {}),
  };
}

// Validate the submitted editor tree as well as its stored Portable Text form.
// A valid ProseMirror composition is not necessarily supported by the converter.
export function contentForSave(document: ProseMirrorDocument) {
  const schema = getSchema(editorExtensions);
  const submitted = schema.nodeFromJSON(document);
  submitted.check();
  const parsed = editorPostSchema.shape.data.shape.document.parse(
    submitted.toJSON(),
  );
  const content = fromEditorDocument(parsed);
  const restored = schema.nodeFromJSON(toEditorDocument(content));
  restored.check();
  const reconstructed = editorPostSchema.shape.data.shape.document.parse(
    restored.toJSON(),
  );
  if (!preservesContent(editorMeaning(parsed), editorMeaning(reconstructed)))
    throw new Error('Lossy editor conversion');
  return content;
}

// Reject editing when conversion or the actual editor schema drops stored data.
// The reference type marker and an explicit local provider are equivalent to
// the converter's default local reference, so those two metadata fields may
// be omitted without changing the referenced asset. Empty text marks and block
// mark definitions also mean the same thing as their omitted defaults.
export function preservesContent(
  original: unknown,
  restored: unknown,
): boolean {
  const originalArray = array.safeParse(original);
  if (originalArray.success) {
    const restoredArray = array.safeParse(restored);
    return (
      restoredArray.success &&
      originalArray.data.length === restoredArray.data.length &&
      originalArray.data.every((value, index) =>
        preservesContent(value, restoredArray.data[index]),
      )
    );
  }
  const originalRecord = record.safeParse(original);
  if (originalRecord.success) {
    const restoredRecord = record.safeParse(restored);
    if (!restoredRecord.success) return false;
    const reference = typeof originalRecord.data._ref === 'string';
    return Object.entries(originalRecord.data).every(
      ([key, value]) =>
        value === undefined ||
        (reference && key === '_type' && value === 'reference') ||
        (reference && key === 'provider' && value === 'local') ||
        (restoredRecord.data[key] === undefined &&
          Array.isArray(value) &&
          value.length === 0 &&
          ((originalRecord.data._type === 'span' && key === 'marks') ||
            (originalRecord.data._type === 'block' && key === 'markDefs'))) ||
        preservesContent(value, restoredRecord.data[key]),
    );
  }
  return Object.is(original, restored);
}
