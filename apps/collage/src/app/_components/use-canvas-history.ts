"use client";

import { type SerializedCanvasObject } from "@/types/canvas";
import { type Canvas } from "fabric";
import { type RefObject, useCallback, useRef, useState } from "react";
import { isDeepEqual } from "remeda";
import { type BackgroundValue } from "./gradient-picker";
import { updateCanvasBackground } from "./canvas";

const HISTORY_LIMIT = 50;

type CanvasSnapshot = {
  objects: SerializedCanvasObject[];
  background: BackgroundValue;
};

type CanvasHistory = {
  past: CanvasSnapshot[];
  current: CanvasSnapshot;
  future: CanvasSnapshot[];
};

type CanvasHistoryOptions = {
  fabricCanvasRef: RefObject<Canvas | null>;
  initialObjects: SerializedCanvasObject[];
  initialBackground: BackgroundValue;
};

export function useCanvasHistory({
  fabricCanvasRef,
  initialObjects,
  initialBackground,
}: CanvasHistoryOptions) {
  const historyRef = useRef<CanvasHistory>({
    past: [],
    current: { objects: initialObjects, background: initialBackground },
    future: [],
  });
  const restoringRef = useRef(false);
  const [objects, setObjects] = useState(initialObjects);
  const [backgroundColor, setBackgroundColor] = useState(initialBackground);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);

  const syncAvailability = useCallback((history: CanvasHistory) => {
    setCanUndo(history.past.length > 0);
    setCanRedo(history.future.length > 0);
  }, []);

  const commit = useCallback(
    (snapshot: CanvasSnapshot) => {
      if (
        restoringRef.current ||
        isDeepEqual(historyRef.current.current, snapshot)
      ) {
        return;
      }

      const history = historyRef.current;
      const nextHistory: CanvasHistory = {
        past: [...history.past, history.current].slice(-HISTORY_LIMIT),
        current: snapshot,
        future: [],
      };
      historyRef.current = nextHistory;
      setObjects(snapshot.objects);
      setBackgroundColor(snapshot.background);
      syncAvailability(nextHistory);
    },
    [syncAvailability],
  );

  const recordObjects = useCallback(
    (nextObjects: SerializedCanvasObject[]) => {
      commit({
        objects: nextObjects,
        background: historyRef.current.current.background,
      });
    },
    [commit],
  );

  const recordBackground = useCallback(
    (nextBackground: BackgroundValue) => {
      commit({
        objects: historyRef.current.current.objects,
        background: nextBackground,
      });
    },
    [commit],
  );

  const restore = useCallback(
    async (snapshot: CanvasSnapshot) => {
      const canvas = fabricCanvasRef.current;
      if (!canvas || restoringRef.current) return false;

      restoringRef.current = true;
      setIsRestoring(true);
      try {
        canvas.discardActiveObject();
        await canvas.loadFromJSON({ objects: snapshot.objects });
        updateCanvasBackground({
          fabricCanvasRef,
          storeBackgroundColor: snapshot.background,
        });
        canvas.requestRenderAll();
        setObjects(snapshot.objects);
        setBackgroundColor(snapshot.background);
        return true;
      } finally {
        restoringRef.current = false;
        setIsRestoring(false);
      }
    },
    [fabricCanvasRef],
  );

  const undo = useCallback(async () => {
    const history = historyRef.current;
    const previous = history.past.at(-1);
    if (!previous || !(await restore(previous))) return;

    const nextHistory: CanvasHistory = {
      past: history.past.slice(0, -1),
      current: previous,
      future: [history.current, ...history.future].slice(0, HISTORY_LIMIT),
    };
    historyRef.current = nextHistory;
    syncAvailability(nextHistory);
  }, [restore, syncAvailability]);

  const redo = useCallback(async () => {
    const history = historyRef.current;
    const next = history.future[0];
    if (!next || !(await restore(next))) return;

    const nextHistory: CanvasHistory = {
      past: [...history.past, history.current].slice(-HISTORY_LIMIT),
      current: next,
      future: history.future.slice(1),
    };
    historyRef.current = nextHistory;
    syncAvailability(nextHistory);
  }, [restore, syncAvailability]);

  return {
    objects,
    backgroundColor,
    recordObjects,
    recordBackground,
    undo,
    redo,
    canUndo,
    canRedo,
    isRestoring,
  };
}
