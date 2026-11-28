import { useEffect, useRef, useState } from "react";
import { AppState, Linking } from "react-native";
import { session, useAccount } from "../account/AccountProvider";
import { appScheme, widget } from "../data/widget";
import { TapBuffer } from "../logic/launch";
import { widgetLink, widgetSnapshot } from "../logic/widget";
import type { WidgetLink } from "../logic/widget";

/**
 * Keeps the Today widget's snapshot current while the account is open:
 * after each load or save, when the plan or targets change, when the day
 * changes and each time the app comes to the foreground.
 */
export function useWidgetSnapshot() {
  const { sync, settings, today } = useAccount();
  const latest = useRef({ settings, records: sync.records });
  // The sign-in this account opened under. Once it ends, its snapshots are never written.
  const [generation] = useState(() => session.generation());

  useEffect(() => {
    latest.current = { settings, records: sync.records };
    if (!settings) return;
    void widget.publish(widgetSnapshot(settings, sync.records, Date.now(), appScheme), generation);
  }, [settings, sync.records, today, generation]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      const { settings: plan, records } = latest.current;
      if (state === "active" && plan)
        void widget.publish(widgetSnapshot(plan, records, Date.now(), appScheme), generation);
    });
    return () => subscription.remove();
  }, [generation]);
}

/** Whether the link that launched the app was handled. It opens once per launch. */
let launchLinkTaken = false;

/**
 * Widget taps while the app runs. The listener starts with the app, so a
 * tap while the account or plan is still loading waits here until
 * navigation mounts and listens.
 */
const widgetTaps = new TapBuffer<WidgetLink>();
Linking.addEventListener("url", ({ url }) => {
  const link = widgetLink(url, appScheme);
  if (link) widgetTaps.push(link);
});

/**
 * Opens a tapped widget link: `open` runs for a tap while the app runs,
 * including one made while the app was still loading, and for the tap
 * that launched the app once navigation is ready.
 */
export function useWidgetLinks(open: (link: WidgetLink) => void) {
  const handler = useRef(open);
  useEffect(() => {
    handler.current = open;
  }, [open]);
  useEffect(() => widgetTaps.listen((link) => handler.current(link)), []);
}

/** The widget link that launched the app, once. */
export async function takeLaunchWidgetLink() {
  if (launchLinkTaken) return null;
  launchLinkTaken = true;
  const url = await Linking.getInitialURL().catch(() => null);
  return url ? widgetLink(url, appScheme) : null;
}
