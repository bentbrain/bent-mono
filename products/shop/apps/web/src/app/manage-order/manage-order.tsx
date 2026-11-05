"use client";

import { ManagedOrder, OrderDeliveryAddress, OrderManagementReceipt, type OrderManagementCommand } from "@forever-tee/contracts/order-management";
import { Either, Schema } from "effect";
import { useEffect, useRef, useState, type SubmitEvent } from "react";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";

const fields = [
  {name: "firstName", label: "First name", autoComplete: "given-name", required: true},
  {name: "lastName", label: "Last name", autoComplete: "family-name", required: true},
  {name: "address1", label: "Address", autoComplete: "address-line1", required: true},
  {name: "address2", label: "Unit or other address details", autoComplete: "address-line2", required: false},
  {name: "city", label: "Suburb or town", autoComplete: "address-level2", required: true},
  {name: "zip", label: "Postcode", autoComplete: "postal-code", required: true},
  {name: "phone", label: "Delivery phone, optional", autoComplete: "tel", required: false},
] satisfies readonly {name: keyof OrderDeliveryAddress; label: string; autoComplete: string; required: boolean}[];
const inputClass = "min-h-11 w-full border border-primary bg-background px-3 py-2 text-base outline-offset-4 focus-visible:outline-2 focus-visible:outline-primary";
export function ManageOrder() {
  const token = useRef("");
  const pendingCommand = useRef<OrderManagementCommand | null>(null);
  const [order, setOrder] = useState<ManagedOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [closed, setClosed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState("");
  const [retry, setRetry] = useState(false);
  useEffect(() => {
    let controller = new AbortController();
    function loadOrder() {
      controller.abort();
      controller = new AbortController();
      const signal = controller.signal;
      const capability = window.location.hash.slice(1);
      token.current = capability;
      pendingCommand.current = null;
      setOrder(null); setLoading(true); setClosed(false); setBusy(false);
      setConfirming(false); setRetry(false); setMessage("");
      if (!/^[A-Za-z0-9_-]{43}$/u.test(capability)) { setMessage("This order link is unavailable. Open the Manage order link in your confirmation email."); setLoading(false); setClosed(true); return; }
      void fetch("/api/manage-order", {headers: {authorization: `Bearer ${capability}`}, cache: "no-store", signal}).then(async response => {
        if (!response.ok) throw new Error(response.status === 410 ? "The correction window has closed or this link is unavailable." : "The order could not be loaded. Refresh to try again.");
        const value: unknown = await response.json();
        const decoded = Schema.decodeUnknownEither(ManagedOrder)(value);
        if (Either.isLeft(decoded)) throw new Error("The order could not be loaded. Refresh to try again.");
        if (!signal.aborted) setOrder(decoded.right);
      }).catch((error: unknown) => { if (!signal.aborted) {setMessage(error instanceof Error ? error.message : "The order could not be loaded."); setClosed(true);} }).finally(() => {if (!signal.aborted) setLoading(false);});
    }
    loadOrder();
    window.addEventListener("hashchange", loadOrder);
    return () => {controller.abort(); window.removeEventListener("hashchange", loadOrder);};
  }, []);
  useEffect(() => {
    if (!order) return;
    const remaining = Math.max(0, Date.parse(order.deadline) - Date.parse(order.serverTime));
    const timeout = window.setTimeout(() => {setClosed(true); setMessage("The one-hour correction window has closed.");}, remaining);
    return () => {window.clearTimeout(timeout);};
  }, [order]);
  async function submit(command: OrderManagementCommand) {
    if (busy) return;
    const capability = token.current;
    pendingCommand.current = command;
    setBusy(true); setRetry(false); setMessage(command.operation === "cancel" ? "Requesting cancellation and full refund…" : "Saving address…");
    try {
      const response = await fetch("/api/manage-order", {method: "POST", headers: {authorization: `Bearer ${capability}`, "content-type": "application/json"}, body: JSON.stringify(command)});
      if (token.current !== capability) return;
      if (!response.ok) {
        if (response.status === 409) {pendingCommand.current = null; setMessage("The order is being checked or changed. Try again shortly."); return;}
        if (response.status === 410) {setClosed(true); setMessage("The correction window has closed. Contact support for help."); return;}
        throw new Error("The change could not be confirmed.");
      }
      const value: unknown = await response.json();
      if (token.current !== capability) return;
      const decoded = Schema.decodeUnknownEither(OrderManagementReceipt)(value);
      if (Either.isLeft(decoded)) throw new Error("The change could not be confirmed.");
      if (decoded.right.status === "ambiguous" || decoded.right.status === "rejected") {
        setMessage(decoded.right.status === "ambiguous" ? "The change needs review. Production is on hold. Contact support before trying again." : "Shopify could not accept this change. Contact support for help.");
        setClosed(command.operation === "cancel" || decoded.right.status === "ambiguous");
        pendingCommand.current = null;
      } else if (command.operation === "cancel") {
        setClosed(true); setConfirming(false); pendingCommand.current = null;
        setMessage(decoded.right.status === "succeeded" ? "Your order is cancelled and fully refunded." : "Cancellation and a full refund have been requested. Your order is on hold. Shopify will email you when the cancellation is processed.");
      } else if (decoded.right.status === "succeeded") {
        setMessage("Address saved. The original correction deadline still applies."); pendingCommand.current = null;
      } else { setRetry(true); setMessage("Your change is still being processed. Check its status shortly."); }
    } catch {if (token.current !== capability) return; setRetry(true); setMessage("The change could not be confirmed. Check its status before making another change.");}
    finally {if (token.current === capability) setBusy(false);}
  }
  function saveAddress(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pendingCommand.current) return;
    const data = Object.fromEntries(new FormData(event.currentTarget));
    const decoded = Schema.decodeUnknownEither(OrderDeliveryAddress)({...data, countryCode: "AU"});
    if (Either.isLeft(decoded)) {setMessage("Check the address, Australian state and four-digit postcode."); return;}
    void submit({commandId: crypto.randomUUID(), operation: "address", address: decoded.right});
  }
  if (loading) return <p role="status">Loading order…</p>;
  return <div className="grid gap-6 text-sm leading-6">
    {order && <div className="grid gap-2"><h2 className="text-lg font-bold">Order {order.orderName}</h2><p>Address corrections and cancellation are available until <time dateTime={order.deadline}>{new Date(order.deadline).toLocaleString("en-AU", {dateStyle: "medium", timeStyle: "short"})}</time>.</p></div>}
    <p role="status" aria-live="polite">{message}</p>
    {retry && <Button className="min-h-11 rounded-none border-primary px-4 font-bold" variant="outline" disabled={busy} onClick={() => {if (pendingCommand.current) void submit(pendingCommand.current);}}>Check change status</Button>}
    {order && !closed && <>
      <form onSubmit={saveAddress} className="grid gap-4" aria-busy={busy}>
        <fieldset disabled={busy || retry} className="grid gap-4 border-t border-primary pt-5"><legend className="px-0 pt-3 text-lg font-bold">Delivery address</legend>
          {fields.map(field => <label key={field.name} className="grid gap-1">{field.label}<input className={inputClass} name={field.name} autoComplete={field.autoComplete} required={field.required} maxLength={field.name === "phone" ? 30 : 100} inputMode={field.name === "zip" ? "numeric" : field.name === "phone" ? "tel" : "text"} pattern={field.name === "zip" ? "[0-9]{4}" : undefined} defaultValue={order.address ? order.address[field.name] : ""} /></label>)}
          <label className="grid gap-1">State or territory<select className={inputClass} name="provinceCode" autoComplete="address-level1" required defaultValue={order.address?.provinceCode ?? ""}><option value="" disabled>Choose state</option>{["ACT", "NSW", "NT", "QLD", "SA", "TAS", "VIC", "WA"].map(state => <option key={state}>{state}</option>)}</select></label>
          <p>Australia only. PO Boxes and Parcel Lockers are accepted subject to address validation.</p>
          <Button className="min-h-11 rounded-none border-primary px-4 font-bold" type="submit" disabled={busy || retry}>{busy ? "SAVING…" : "SAVE ADDRESS"}</Button>
        </fieldset>
      </form>
      <section className="grid gap-3 border-t border-primary pt-5"><h2 className="text-lg font-bold">Cancel order</h2><p>Cancel every item for a full refund to your original payment method.</p>
        <AlertDialog open={confirming} onOpenChange={setConfirming}><AlertDialogTrigger asChild><Button className="min-h-11 rounded-none border-primary px-4 font-bold" variant="outline" disabled={busy || retry}>CANCEL ORDER</Button></AlertDialogTrigger>
          <AlertDialogContent className="rounded-none border border-primary bg-background text-primary ring-0"><AlertDialogHeader><AlertDialogTitle>Cancel the whole order?</AlertDialogTitle><AlertDialogDescription className="text-primary">All items will be cancelled and fully refunded. This cannot be undone.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={busy} className="min-h-11 rounded-none border-primary">Keep order</AlertDialogCancel><Button className="min-h-11 rounded-none border-primary px-4 font-bold" disabled={busy} onClick={() => void submit({commandId: crypto.randomUUID(), operation: "cancel", confirmation: "CANCEL AND REFUND"})}>{busy ? "REQUESTING…" : "CANCEL AND REFUND"}</Button></AlertDialogFooter></AlertDialogContent>
        </AlertDialog>
      </section>
    </>}
    <p>Need help? Email <a href="mailto:support@bent.build" className="underline">support@bent.build</a>{order ? ` with order ${order.orderName}` : " with your order number"}. Keep this private link to yourself.</p>
  </div>;
}
