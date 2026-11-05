"use client";

import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { wifiQrValue } from "@/lib/wifi-qr";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function WifiDetails({
  password,
  network,
}: {
  password: string;
  network: string;
}) {
  const [visible, setVisible] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [message, setMessage] = useState("");
  return (
    <div className="space-y-3 border p-4">
      <p className="normal-case">{network}</p>
      <p className="text-xs">password</p>
      <p className="break-all normal-case">{visible ? password : "••••••••"}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => setVisible(!visible)}>
          {visible ? "hide password" : "show password"}
        </Button>
        <Button
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(password);
              setMessage("password copied");
            } catch {
              setVisible(true);
              setMessage("copy unavailable. the password is shown above.");
            }
          }}
        >
          copy password
        </Button>
        <Button variant="outline" onClick={() => setShowQr(!showQr)}>
          {showQr ? "hide QR code" : "show QR code"}
        </Button>
      </div>
      {showQr && (
        <div className="space-y-3">
          <QRCodeSVG
            value={wifiQrValue(network, password)}
            size={224}
            marginSize={4}
            title={`Join ${network}`}
            className="max-w-full"
          />
          <p className="text-xs leading-6">
            Scan with another device&apos;s camera to join the network.
          </p>
        </div>
      )}
      <p role="status" className="text-xs">
        {message}
      </p>
    </div>
  );
}

export function WifiSetup({
  network,
  configured,
  onSaved,
}: {
  network: string;
  configured: boolean;
  onSaved: (password: string) => void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  return (
    <form
      className="space-y-3 border p-4"
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        setBusy(true);
        setMessage("");
        try {
          const response = await fetch("/api/wifi", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password }),
          });
          if (!response.ok) throw new Error("save failed");
          onSaved(password);
          setPassword("");
          setMessage("saved. invited guests can now view the Wi-Fi details.");
        } catch {
          setMessage("couldn't save the password. try again.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3 className="font-medium">Wi-Fi</h3>
      <p className="normal-case">{network}</p>
      <label htmlFor="wifi-password" className="block text-xs">
        {configured ? "replace password" : "password"}
      </label>
      <Input
        id="wifi-password"
        type="password"
        autoComplete="off"
        minLength={8}
        maxLength={64}
        required
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />
      <Button type="submit" disabled={busy}>
        {busy ? "saving…" : "save Wi-Fi"}
      </Button>
      <p role="status" className="text-xs leading-6">
        {message}
      </p>
    </form>
  );
}
