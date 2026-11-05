import StarterKit from "@tiptap/starter-kit";
import ImageExtension from "@tiptap/extension-image";
import Youtube from "@tiptap/extension-youtube";

export function richEditorExtensions() {
  return [
    StarterKit.configure({
      heading: { levels: [2, 3] },
      codeBlock: false,
      trailingNode: false,
      link: { openOnClick: false },
    }),
    ImageExtension,
    Youtube.configure({
      nocookie: true,
      width: 640,
      height: 360,
      HTMLAttributes: {
        referrerpolicy: "strict-origin-when-cross-origin",
        title: "YouTube video",
      },
    }),
  ];
}
