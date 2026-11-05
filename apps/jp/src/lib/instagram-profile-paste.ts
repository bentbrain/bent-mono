import { Extension } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { AllSelection, Plugin, PluginKey } from '@tiptap/pm/state';
import { instagramProfile } from './instagram-profile';

export const InstagramProfilePaste = Extension.create({
  name: 'instagramProfilePaste',
  // Handle a single profile before the standard link-on-paste handler.
  priority: 1100,
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('instagramProfilePaste'),
        props: {
          handlePaste: (view, event, slice) => {
            const value = event.clipboardData?.getData('text/plain') || '';
            const profile = instagramProfile(value);
            const { selection, schema, storedMarks } = view.state;
            const block = slice.content.firstChild;
            const text = block?.firstChild;
            const link = schema.marks.link;
            if (
              !profile ||
              !view.editable ||
              !link ||
              (!selection.$from.parent.isTextblock &&
                !(selection instanceof AllSelection)) ||
              selection.$from.parent.type.spec.code ||
              selection.$to.parent.type.spec.code
            )
              return false;
            // Plain text is already a single URL. For HTML, preserve rich or
            // multi-block content instead of replacing it with a handle.
            if (
              event.clipboardData?.getData('text/html') &&
              (slice.content.childCount !== 1 ||
                !block?.isTextblock ||
                block.childCount !== 1 ||
                !text?.isText ||
                text.text?.trim() !== value.trim() ||
                text.marks.some((mark) => mark.type.name !== 'link'))
            )
              return false;
            const marks = storedMarks ?? selection.$from.marks();
            if (marks.some((mark) => mark.type.spec.code)) return false;
            const formatting = marks.filter((mark) => mark.type !== link);
            view.dispatch(
              closeHistory(view.state.tr)
                .replaceSelectionWith(
                  schema.text(profile.handle, [
                    ...formatting,
                    link.create({ href: profile.href }),
                  ]),
                  false,
                )
                .setStoredMarks(formatting)
                .setMeta('preventAutolink', true)
                .setMeta('paste', true)
                .setMeta('uiEvent', 'paste')
                .scrollIntoView(),
            );
            return true;
          },
        },
      }),
    ];
  },
});
