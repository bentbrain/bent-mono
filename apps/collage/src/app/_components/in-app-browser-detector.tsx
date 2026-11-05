"use client";

import React, { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

export function InAppBrowserDetector({
  children,
}: {
  children: React.ReactNode;
}) {
  const [isInAppBrowser, setIsInAppBrowser] = useState(false);
  const [browserType, setBrowserType] = useState<string | null>(null);

  useEffect(() => {
    // Function to detect if user is in an in-app browser
    const detectInAppBrowser = () => {
      const ua = navigator.userAgent || navigator.vendor || "";

      // Check for Instagram
      if (ua.includes("Instagram")) {
        setIsInAppBrowser(true);
        setBrowserType("Instagram");
        return;
      }

      // Check for Facebook/Messenger
      if (ua.includes("FBAN") || ua.includes("FBAV")) {
        setIsInAppBrowser(true);
        setBrowserType("Facebook");
        return;
      }

      // Check for TikTok
      if (ua.includes("TikTok")) {
        setIsInAppBrowser(true);
        setBrowserType("TikTok");
        return;
      }

      // Check for LinkedIn
      if (ua.includes("LinkedInApp")) {
        setIsInAppBrowser(true);
        setBrowserType("LinkedIn");
        return;
      }

      // Not in an in-app browser
      setIsInAppBrowser(false);
      setBrowserType(null);
    };

    detectInAppBrowser();
  }, []);

  if (!isInAppBrowser) return <>{children}</>;

  return (
    <Card className="mx-auto max-w-md border-red-600 bg-white text-red-600">
      <CardHeader>
        <CardTitle>Welcome 🫶🏼</CardTitle>
      </CardHeader>
      <CardContent>
        <div>
          <p className="text-sm">
            In-app browsers are not supported. You&apos;re using the{" "}
            {browserType} in-app browser, which may cause issues with login and
            other features. Pls try using a different browser.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
