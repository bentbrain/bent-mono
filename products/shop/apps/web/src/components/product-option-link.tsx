"use client";

import Link from "next/link";
import { useRef, type ComponentProps } from "react";

type ProductOptionLinkProps = Omit<
  ComponentProps<typeof Link>,
  "onClick" | "onPointerDown" | "onPointerUp" | "onPointerCancel" | "onContextMenu"
> & { onSelect: () => void };

export function ProductOptionLink({ onSelect, ...props }: ProductOptionLinkProps) {
  const touchPointer = useRef<number | undefined>(undefined);
  const lastPointerType = useRef("");

  return (
    <Link
      {...props}
      onPointerDown={(event) => {
        lastPointerType.current = event.pointerType;
        touchPointer.current = event.pointerType === "touch" && event.isPrimary
          ? event.pointerId : undefined;
      }}
      onPointerCancel={() => { touchPointer.current = undefined; }}
      onContextMenu={() => { touchPointer.current = undefined; }}
      onPointerUp={(event) => {
        const pointer = touchPointer.current;
        touchPointer.current = undefined;
        if (event.pointerType !== "touch" || pointer !== event.pointerId) return;
        const target = event.currentTarget.ownerDocument.elementFromPoint(
          event.clientX, event.clientY,
        );
        // Scroll gestures cancel the pointer. A release outside the link also
        // leaves selection unchanged, including implicitly captured touches.
        if (target && event.currentTarget.contains(target)) onSelect();
      }}
      onClick={(event) => {
        const native = event.nativeEvent;
        const touchClick = typeof PointerEvent !== "undefined" &&
          native instanceof PointerEvent && native.pointerType
          ? native.pointerType === "touch"
          : lastPointerType.current === "touch";
        // iOS compatibility clicks may be delayed or missing. Touch release has
        // already made the choice; a late click must not restore an older colour.
        // Keyboard and assistive-technology clicks have detail 0 and remain valid.
        if (event.detail !== 0 && touchClick) {
          event.preventDefault();
          return;
        }
        onSelect();
      }}
    />
  );
}
