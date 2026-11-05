import { useEffect, useState, type SubmitEvent } from 'react';
import { newsletterPublicRequest } from '../lib/newsletter-client';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Field, FieldLabel } from './ui/field';

export function NewsletterSignup() {
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(true);
  }, []);
  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    setBusy(true);
    try {
      await newsletterPublicRequest('subscribe', {
        email: values.get('email'),
        website: values.get('website'),
      });
      setStatus('check your inbox for a confirmation link.');
      form.reset();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'please try again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      data-feedback-id="newsletter-signup"
      aria-label="newsletter"
      className="w-full"
    >
      <div>
        <form
          data-feedback-redact
          data-feedback-private
          onSubmit={(event) => {
            void submit(event);
          }}
          className="flex w-full items-end gap-2"
        >
          <Field className="min-w-0 flex-1">
            <FieldLabel htmlFor="newsletter-email" className="sr-only">
              email
            </FieldLabel>
            <Input
              id="newsletter-email"
              name="email"
              type="email"
              autoComplete="email"
              maxLength={254}
              required
              disabled={!ready || busy}
              placeholder="you@example.com"
              className="rounded-none"
            />
          </Field>
          <div hidden aria-hidden="true">
            <label htmlFor="newsletter-website">website</label>
            <input
              id="newsletter-website"
              name="website"
              type="text"
              tabIndex={-1}
              autoComplete="off"
            />
          </div>
          <Button type="submit" disabled={!ready || busy}>
            {busy ? 'SENDING…' : 'SUBSCRIBE'}
          </Button>
        </form>
        <p role="status" className="text-xs [&:not(:empty)]:mt-3">
          {status}
        </p>
      </div>
    </section>
  );
}
