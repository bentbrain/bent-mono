import type { ReactNode } from "react";

export function CameraPreparingPage({
  children,
  label = "Preparing camera",
}: {
  children?: ReactNode;
  label?: string;
}) {
  return (
    <main className="relative grid flex-1 place-items-center bg-background px-5 pt-12 text-primary">
      <CameraPreparingIndicator label={label}>{children}</CameraPreparingIndicator>
    </main>
  );
}

export function CameraPreparingIndicator({
  children,
  label = "Preparing camera",
}: {
  children?: ReactNode;
  label?: string;
}) {
  return (
    <div
      className="grid justify-items-center gap-4"
      role="status"
      aria-label={label}
    >
      <PreparationSpinner />
      <span className="sr-only">{label}…</span>
      {children}
    </div>
  );
}

export function PreparationSpinner() {
  return (
    <span
      className="block size-5 animate-spin rounded-full border-2 border-primary/20 border-t-primary motion-reduce:animate-none"
      aria-hidden="true"
    />
  );
}
