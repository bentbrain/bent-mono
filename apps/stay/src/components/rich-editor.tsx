"use client";

import { useEffect, useState } from "react";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { richEditorExtensions } from "@/lib/rich-editor-extensions";
import { Button } from "@/components/ui/button";
import {
  guidePhotos,
  isGuideLink,
  richDocumentSchema,
  youtubeId,
  type RichDocument,
} from "@/lib/rich-text";

export function RichEditor({
  value,
  disabled,
  onChange,
  onValidityChange,
}: {
  value: RichDocument;
  disabled: boolean;
  onChange: (body: RichDocument) => void;
  onValidityChange: (message: string) => void;
}) {
  const [insert, setInsert] = useState<"link" | "youtube" | "photo" | null>(
    null,
  );
  const [url, setUrl] = useState("");
  const [photoSrc, setPhotoSrc] = useState(guidePhotos[0].src);
  const [caption, setCaption] = useState(guidePhotos[0].alt);
  const [error, setError] = useState("");
  const editor = useEditor({
    extensions: richEditorExtensions(),
    content: value,
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-label": "Guide content",
        "aria-multiline": "true",
        class: "guide-prose min-h-64 p-4 outline-none",
      },
    },
    onUpdate: ({ editor }) => {
      const parsed = richDocumentSchema.safeParse(editor.getJSON());
      onValidityChange(
        parsed.success
          ? ""
          : (parsed.error.issues[0]?.message ?? "Please check the content."),
      );
      if (parsed.success) onChange(parsed.data);
    },
  });
  useEffect(() => {
    editor?.setEditable(!disabled, false);
  }, [editor, disabled]);
  const active = useEditorState({
    editor,
    selector: ({ editor }) => ({
      bold: editor?.isActive("bold") ?? false,
      italic: editor?.isActive("italic") ?? false,
      heading: editor?.isActive("heading") ?? false,
      bullet: editor?.isActive("bulletList") ?? false,
      numbered: editor?.isActive("orderedList") ?? false,
    }),
  });
  function insertContent() {
    if (!editor) return;
    if (insert === "link") {
      if (!isGuideLink(url)) {
        setError("Use a guide, home controls, https, telephone or email link.");
        return;
      }
      if (editor.state.selection.empty)
        editor
          .chain()
          .focus()
          .insertContent({
            type: "text",
            text: url,
            marks: [{ type: "link", attrs: { href: url } }],
          })
          .run();
      else
        editor
          .chain()
          .focus()
          .extendMarkRange("link")
          .setLink({ href: url })
          .run();
    } else if (insert === "youtube") {
      const id = youtubeId(url);
      if (!id) {
        setError("Enter a YouTube video link.");
        return;
      }
      editor.commands.setYoutubeVideo({
        src: `https://www.youtube.com/watch?v=${id}`,
        width: 640,
        height: 360,
      });
    } else if (insert === "photo") {
      const photo = guidePhotos.find((item) => item.src === photoSrc);
      if (!photo) return;
      const attrs = {
        src: photo.src,
        alt: caption || photo.alt,
        width: photo.width,
        height: photo.height,
      };
      if (editor.isActive("image"))
        editor.chain().focus().updateAttributes("image", attrs).run();
      else editor.chain().focus().setImage(attrs).run();
    }
    setInsert(null);
    setError("");
  }
  return (
    <section aria-label="Rich text editor" className="border">
      <div
        className="flex flex-wrap gap-1 border-b p-2"
        role="toolbar"
        aria-label="Text formatting"
      >
        <Button
          variant="outline"
          disabled={disabled || !editor}
          aria-pressed={active?.bold}
          onClick={() => editor?.chain().focus().toggleBold().run()}
        >
          bold
        </Button>
        <Button
          variant="outline"
          disabled={disabled || !editor}
          aria-pressed={active?.italic}
          onClick={() => editor?.chain().focus().toggleItalic().run()}
        >
          italic
        </Button>
        <Button
          variant="outline"
          disabled={disabled || !editor}
          aria-pressed={active?.heading}
          onClick={() =>
            editor?.chain().focus().toggleHeading({ level: 2 }).run()
          }
        >
          heading
        </Button>
        <Button
          variant="outline"
          disabled={disabled || !editor}
          aria-pressed={active?.bullet}
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
        >
          bullets
        </Button>
        <Button
          variant="outline"
          disabled={disabled || !editor}
          aria-pressed={active?.numbered}
          onClick={() => editor?.chain().focus().toggleOrderedList().run()}
        >
          numbered list
        </Button>
        {(
          ["link", "youtube", "photo"] satisfies (
            "link" | "youtube" | "photo"
          )[]
        ).map((kind) => (
          <Button
            variant="outline"
            key={kind}
            disabled={disabled || !editor}
            onClick={() => {
              setInsert(kind);
              setUrl("");
              setError("");
            }}
          >
            {" "}
            {kind === "youtube" ? "video" : kind}{" "}
          </Button>
        ))}
        <Button
          variant="ghost"
          disabled={disabled || !editor}
          onClick={() => editor?.chain().focus().unsetLink().run()}
        >
          unlink
        </Button>
        <Button
          variant="ghost"
          disabled={disabled || !editor}
          onClick={() => editor?.chain().focus().undo().run()}
        >
          undo
        </Button>
        <Button
          variant="ghost"
          disabled={disabled || !editor}
          onClick={() => editor?.chain().focus().redo().run()}
        >
          redo
        </Button>
      </div>
      {insert && (
        <form
          className="space-y-3 border-b p-4 text-xs"
          onSubmit={(event) => {
            event.preventDefault();
            insertContent();
          }}
        >
          {insert === "photo" ? (
            <>
              <label className="block">
                Apartment photo
                <select
                  className="mt-1 min-h-11 w-full border bg-background p-2"
                  value={photoSrc}
                  onChange={(event) => {
                    setPhotoSrc(event.target.value);
                    setCaption(
                      guidePhotos.find(
                        (item) => item.src === event.target.value,
                      )?.alt ?? "",
                    );
                  }}
                >
                  {guidePhotos.map((photo) => (
                    <option key={photo.src} value={photo.src}>
                      {photo.alt}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                Photo caption
                <input
                  className="mt-1 min-h-11 w-full border bg-background p-2"
                  value={caption}
                  onChange={(event) => setCaption(event.target.value)}
                />
              </label>
            </>
          ) : (
            <label className="block">
              {insert === "youtube" ? "YouTube video link" : "Link address"}
              <input
                autoFocus
                className="mt-1 min-h-11 w-full border bg-background p-2"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
            </label>
          )}
          <div className="flex gap-2">
            <Button type="submit">insert</Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setInsert(null)}
            >
              cancel
            </Button>
          </div>
          {error && <p role="alert">{error}</p>}
        </form>
      )}
      <EditorContent editor={editor} />
    </section>
  );
}
