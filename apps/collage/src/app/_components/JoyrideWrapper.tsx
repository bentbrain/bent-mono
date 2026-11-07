"use client";
import { api } from "@/trpc/react";
import { SquareX } from "lucide-react";
import dynamic from "next/dynamic";
import { forwardRef } from "react";
import {
  type BeaconRenderProps,
  type EventData,
  type TooltipRenderProps,
} from "react-joyride";
import { Button } from "./ui/button";

const BeaconComponent = forwardRef<HTMLButtonElement, BeaconRenderProps>(
  ({ continuous: _continuous, isLastStep: _isLastStep, ...rest }, ref) => {
    return (
      <button
        ref={ref}
        {...rest}
        className="h-4 w-4 animate-ping rounded-full border border-black bg-pink-400/80"
      />
    );
  },
);

BeaconComponent.displayName = "BeaconComponent";

const CustomTooltip: React.FC<TooltipRenderProps> = ({
  backProps,
  closeProps,
  continuous,
  index,
  primaryProps,
  step,
  tooltipProps,
}: TooltipRenderProps) => {
  return (
    <div
      className="relative max-w-md gap-2 rounded-sm bg-white p-4 text-black shadow-none"
      {...tooltipProps}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          {step.title && (
            <h4 className="mb-2 text-lg font-semibold">{step.title}</h4>
          )}
          <div className="mb-4 text-sm">{step.content}</div>
        </div>
        <button {...closeProps} className="text-gray-600 hover:text-gray-900">
          <SquareX className="h-6 w-6" />
        </button>
      </div>
      <div className="flex items-center justify-between">
        {index > 0 && (
          <Button asChild variant="outline">
            <button {...backProps}>{backProps.title ?? "Back"}</button>
          </Button>
        )}
        {continuous && (
          <Button className="ml-auto" asChild variant="outline">
            <button {...primaryProps}>{primaryProps.title ?? "Next"}</button>
          </Button>
        )}
      </div>
    </div>
  );
};

const JoyRideNoSSR = dynamic(
  () => import("react-joyride").then(({ Joyride }) => Joyride),
  { ssr: false },
);
function JoyrideWrapper({
  startTutorial,
  setStartTutorial,
  userId,
}: {
  userId: string;
  startTutorial: {
    running: boolean;
    stepIndex: number | undefined;
  };
  setStartTutorial: React.Dispatch<
    React.SetStateAction<{
      running: boolean;
      stepIndex: number | undefined;
    }>
  >;
}) {
  const updateTutorialViewed = api.user.updatePreferences.useMutation({
    onSuccess: () => {
      setStartTutorial({
        running: false,
        stepIndex: 0,
      });
    },
  });

  const handleStateChange = (state: EventData) => {
    if (state.action === "close" || state.action === "skip") {
      updateTutorialViewed.mutate({
        userId: userId,
        tutorialViewed: true,
      });
      setStartTutorial({
        running: false,
        stepIndex: 0,
      });
    }
  };

  const state = {
    steps: [
      {
        target: "#category-select",
        title: "Choose categories",
        content: "Choose a category to browse its stickers.",
        disableBeacon: true,
      },
      {
        target: '[data-joyride="draggable-image"]',
        title: "Add stickers",
        content:
          "Click or drag an image onto the canvas to add it to your collage.",
      },
      {
        target: '[data-joyride="background-picker"]',
        title: "Background",
        content: "Choose a background colour, gradient or image.",
      },
      {
        target: '[data-joyride="save-button"]',
        title: "Save",
        content: "Save your collage when you finish editing.",
      },
    ],
  };

  return (
    <JoyRideNoSSR
      run={startTutorial.running}
      continuous={true}
      tooltipComponent={CustomTooltip}
      steps={state.steps}
      stepIndex={startTutorial.stepIndex}
      beaconComponent={BeaconComponent}
      locale={{
        last: "Done",
      }}
      onEvent={handleStateChange}
    />
  );
}

export default JoyrideWrapper;
