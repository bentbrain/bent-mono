"use client";

import { CheckIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState, type SyntheticEvent } from "react";

import { preloadCreatedDraft } from "@/client/draft-handoff";
import { IMAGE_UPLOAD_ACCEPT, prepareImageUpload } from "@/client/image-upload";
import {
  captureStorefrontAction,
  captureClientException,
} from "@/client/posthog";
import { CameraPermissionLauncher } from "@/components/camera-permission-launcher";
import { Button } from "@/components/ui/button";

import { CONTENT_DECLARATION_FIELD } from "@/server/content-declaration-core";

export function CameraLanding() {
  const navigate = useNavigate();
  const [opening, setOpening] = useState(false);
  const [image, setImage] = useState<File>();
  const [uploadError, setUploadError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  async function uploadImage(file: File) {
    const form = formRef.current;
    if (opening || !form?.reportValidity()) return;
    captureStorefrontAction("image_upload_started");
    setOpening(true);
    setUploadError("");
    try {
      const prepared = await prepareImageUpload(file);
      const response = await fetch("/api/content-declaration", {
        body: new FormData(form),
        headers: { accept: "application/json" },
        method: "POST",
      });
      if (!response.ok)
        throw new Error(
          "The declaration could not be saved. Please try again.",
        );
      setImage(prepared);
    } catch (error) {
      if (error instanceof Error) captureClientException(error);
      setUploadError(
        error instanceof Error
          ? error.message
          : "This image could not be opened. Please try again.",
      );
      setOpening(false);
    }
  }

  async function openCamera(
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ) {
    event.preventDefault();
    const form = event.currentTarget;
    if (opening || !form.reportValidity()) return;
    captureStorefrontAction("camera_open_requested");

    setOpening(true);
    try {
      const response = await fetch("/api/content-declaration", {
        body: new FormData(form),
        headers: { accept: "application/json" },
        method: "POST",
      });
      if (!response.ok) throw new Error("The declaration could not be saved.");
      void navigate({ to: "/create/camera" });
      window.setTimeout(() => {
        form.reset();
        setOpening(false);
      }, 0);
    } catch {
      form.submit();
    }
  }

  if (image) {
    return (
      <CameraPermissionLauncher
        image={image}
        onDraftCreated={(id) => {
          preloadCreatedDraft(id);
          void navigate({
            to: "/design/$id",
            params: { id },
            search: { upload: true, camera: false },
          });
          window.setTimeout(() => {
            setImage(undefined);
            setOpening(false);
          }, 0);
        }}
      />
    );
  }

  return (
    <section className="relative z-10 grid flex-1 place-items-center p-[clamp(1rem,4vw,4rem)] max-sm:px-5 max-sm:py-8">
      <div className="w-[min(100%,36rem)]">
        <ol className="grid list-decimal gap-3 pl-6 text-[clamp(0.85rem,2vw,1rem)] leading-[1.6]">
          <li>Open the camera or upload an image</li>
          <li>Wear a blank t-shirt in your photo</li>
          <li>Frame your head and torso in the photo</li>
        </ol>
        <form
          ref={formRef}
          className="mt-8 grid gap-5"
          action="/api/content-declaration"
          method="post"
          onSubmit={(event) => void openCamera(event)}
        >
          <label className="grid grid-cols-[1.5rem_1fr] items-start gap-3 text-xs leading-5">
            <span className="relative mt-0.5 size-5">
              <input
                className="peer size-5 appearance-none border border-primary checked:bg-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                name={CONTENT_DECLARATION_FIELD}
                required
                type="checkbox"
                value="accepted"
              />
              <CheckIcon
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 hidden size-5 text-white peer-checked:block"
                strokeWidth={3}
              />
            </span>
            <span>
              I&apos;m 18 or older. I have permission to use and print this
              image, including consent from every person shown, and it follows
              the{" "}
              <a className="underline" href="/content-rules">
                content rules
              </a>
              .
            </span>
          </label>
          <button
            className="grid min-h-14 w-full place-items-center rounded-none border border-primary bg-primary px-[1.4rem] py-4 font-mono text-[0.72rem] font-bold tracking-[0.06em] text-primary-foreground uppercase hover:bg-background hover:text-primary"
            disabled={opening}
            type="submit"
          >
            {opening ? "Opening…" : "Open camera"}
          </button>
          <Button
            className="min-h-14 w-full rounded-none border border-primary bg-background px-4 py-4 font-mono text-[0.72rem] font-bold tracking-[0.06em] text-primary uppercase hover:bg-primary hover:text-primary-foreground"
            disabled={opening}
            type="button"
            onClick={() => {
              if (formRef.current?.reportValidity()) fileInput.current?.click();
            }}
          >
            Upload image
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept={IMAGE_UPLOAD_ACCEPT}
            aria-label="Choose image"
            className="hidden"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) void uploadImage(file);
            }}
          />
          {uploadError ? (
            <p role="alert" className="text-xs leading-5">
              {uploadError}
            </p>
          ) : null}
        </form>
      </div>
    </section>
  );
}
