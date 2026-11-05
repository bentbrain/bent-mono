import { useEffect, useState, type SubmitEvent } from 'react';
import { newsletterOwnerRequest } from '../lib/newsletter-client';
import type {
  NewsletterSettings,
  NewsletterStatus,
} from '../lib/newsletter-model';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Field, FieldLabel } from './ui/field';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from './ui/select';
import { Checkbox } from './ui/checkbox';

const weekdays = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];
export function OwnerNewsletter() {
  const [status, setStatus] = useState<NewsletterStatus>();
  const [settings, setSettings] = useState<NewsletterSettings>();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void newsletterOwnerRequest()
      .then((value) => {
        if (!cancelled) {
          setStatus(value);
          setSettings(value.settings);
        }
      })
      .catch(() => {
        if (!cancelled) setMessage('could not load newsletter settings.');
      });
    return () => {
      cancelled = true;
    };
  }, []);
  async function action(body: unknown, success: string) {
    setBusy(true);
    try {
      const value = await newsletterOwnerRequest(body);
      setStatus(value);
      setSettings(value.settings);
      setMessage(success);
      setPreview((value) => value + 1);
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'please try again.');
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function connect(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    if (
      await action(
        { action: 'connect', apiKey: data.get('apiKey') },
        'resend connected. automatic sending stays paused until you enable it.',
      )
    )
      form.reset();
  }
  function update(values: Partial<NewsletterSettings>) {
    setSettings((current) => (current ? { ...current, ...values } : current));
  }
  return (
    <section data-feedback-id="newsletter-owner" className="space-y-6">
      <h1>newsletter</h1>
      <p>from hi@jp.bent.build · replies go to your owner inbox</p>
      <p role="status" className="break-words">
        {message}
      </p>
      {!status || !settings ? (
        <p>loading newsletter…</p>
      ) : (
        <>
          <div className="grid gap-6 min-[901px]:grid-cols-[minmax(280px,360px)_minmax(0,1fr)]">
            <div className="space-y-6">
              <div className="border p-4 space-y-3">
                <p>{status.confirmed} confirmed signups</p>
                <p className="text-xs">
                  Resend manages current subscriptions, unsubscribes and
                  delivery failures.
                </p>
                <p>
                  {status.settings.enabled
                    ? 'automatic sending enabled'
                    : 'automatic sending paused'}
                </p>
                {status.configured && (
                  <p className="text-xs">
                    next scheduled check:{' '}
                    {new Date(status.nextSend).toLocaleString('en-GB', {
                      timeZone: 'Asia/Tokyo',
                    })}{' '}
                    japan time
                  </p>
                )}
              </div>
              <form
                data-feedback-private
                data-feedback-redact
                className="space-y-3 border p-4"
                onSubmit={(event) => {
                  void connect(event);
                }}
              >
                <h2>
                  {status.configured ? 'resend connection' : 'connect resend'}
                </h2>
                <p className="text-xs">
                  use a full access key from your blog Resend account. saved
                  encrypted in emdash.
                </p>
                <Field>
                  <FieldLabel htmlFor="newsletter-api-key">
                    resend api key
                  </FieldLabel>
                  <Input
                    id="newsletter-api-key"
                    type="password"
                    name="apiKey"
                    autoComplete="off"
                    placeholder={
                      status.configured ? 'enter a replacement key' : 're_…'
                    }
                    required
                    className="rounded-none"
                  />
                </Field>
                <Button disabled={busy} type="submit">
                  {status.configured ? 'UPDATE CONNECTION' : 'CONNECT RESEND'}
                </Button>
              </form>
              <form
                className="space-y-4 border p-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  void action(
                    { action: 'settings', settings },
                    'schedule saved.',
                  );
                }}
              >
                <h2>schedule</h2>
                <Field orientation="horizontal">
                  <Checkbox
                    id="newsletter-enabled"
                    checked={settings.enabled}
                    onCheckedChange={(enabled) => {
                      update({ enabled });
                    }}
                    disabled={!status.configured}
                  />
                  <FieldLabel htmlFor="newsletter-enabled">
                    automatic sending
                  </FieldLabel>
                </Field>
                <Field>
                  <FieldLabel htmlFor="newsletter-frequency">
                    frequency
                  </FieldLabel>
                  <Select
                    value={settings.frequency}
                    onValueChange={(value) => {
                      if (value === 'weekly' || value === 'interval')
                        update({ frequency: value });
                    }}
                  >
                    <SelectTrigger
                      id="newsletter-frequency"
                      className="rounded-none"
                    >
                      <SelectValue>
                        {settings.frequency === 'weekly'
                          ? 'weekly'
                          : 'every few days'}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="weekly">weekly</SelectItem>
                      <SelectItem value="interval">every few days</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                {settings.frequency === 'weekly' ? (
                  <Field>
                    <FieldLabel htmlFor="newsletter-weekday">day</FieldLabel>
                    <Select
                      value={String(settings.weekday)}
                      onValueChange={(value) => {
                        if (value !== null) update({ weekday: Number(value) });
                      }}
                    >
                      <SelectTrigger
                        id="newsletter-weekday"
                        className="rounded-none"
                      >
                        <SelectValue>{weekdays[settings.weekday]}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {weekdays.map((day, index) => (
                          <SelectItem value={String(index)} key={day}>
                            {day}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                ) : (
                  <Field>
                    <FieldLabel htmlFor="newsletter-days">
                      days between emails
                    </FieldLabel>
                    <Input
                      id="newsletter-days"
                      type="number"
                      min={1}
                      max={30}
                      value={settings.days}
                      onChange={(event) => {
                        update({ days: Number(event.target.value) });
                      }}
                      required
                    />
                  </Field>
                )}
                <Field>
                  <FieldLabel htmlFor="newsletter-hour">
                    hour in japan, 0–23
                  </FieldLabel>
                  <Input
                    id="newsletter-hour"
                    type="number"
                    min={0}
                    max={23}
                    value={settings.hour}
                    onChange={(event) => {
                      update({ hour: Number(event.target.value) });
                    }}
                    required
                  />
                </Field>
                <p className="text-xs">
                  only newly published entries. quiet periods are skipped. up to
                  24 entries per email.
                </p>
                <Button type="submit" disabled={busy}>
                  SAVE SCHEDULE
                </Button>
              </form>
              {status.lastRun && (
                <div className="border p-4 space-y-3">
                  <h2>last send</h2>
                  <p>
                    {status.lastRun.status} · {status.lastRun.postCount} entries
                  </p>
                  {[
                    'uncertain',
                    'preparing',
                    'sending',
                    'draft',
                    'discarding',
                  ].includes(status.lastRun.status) && (
                    <>
                      <p className="text-xs">
                        automatic sends wait while this delivery needs checking.
                      </p>
                      <Button
                        disabled={busy}
                        onClick={() => {
                          void action(
                            { action: 'check' },
                            'delivery status checked.',
                          );
                        }}
                      >
                        CHECK DELIVERY
                      </Button>
                    </>
                  )}
                  {status.lastRun.status === 'draft' && (
                    <div className="space-y-3">
                      <Button
                        disabled={busy}
                        onClick={() => {
                          void action(
                            { action: 'resume' },
                            'saved email sent to subscribers.',
                          );
                        }}
                      >
                        SEND SAVED DRAFT
                      </Button>
                      <p className="text-xs">
                        if entries changed, discard this unsent draft. entries
                        return to the next scheduled digest.
                      </p>
                      <Button
                        disabled={busy}
                        onClick={() => {
                          void action(
                            { action: 'discard' },
                            'draft checked. entries from an unsent draft return to the next scheduled digest.',
                          );
                        }}
                      >
                        DISCARD SAVED DRAFT
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="min-w-0 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2>next digest · {status.posts.length} entries</h2>
                <Button
                  disabled={busy || !status.configured || !status.posts.length}
                  onClick={() => {
                    void action(
                      { action: 'test' },
                      'test email sent to your owner inbox. subscribers were not emailed.',
                    );
                  }}
                >
                  SEND ME A TEST
                </Button>
              </div>
              {status.posts.length ? (
                <iframe
                  key={preview}
                  src="/api/trip/newsletter-preview"
                  title="Newsletter email preview"
                  sandbox=""
                  className="h-[740px] w-full border bg-white"
                />
              ) : (
                <p className="border p-6">
                  no new published entries. sample content is excluded.
                </p>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
