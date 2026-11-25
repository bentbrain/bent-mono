import { useCallback, useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router';
import type { SubmitEvent } from 'react';
import { ArrowUpRight, Check, Loader2 } from 'lucide-react';
import { z } from 'zod';
import { toast } from 'sonner';
import { defaultTheme, publicUserSchema } from '../../shared/models.js';
import { applyTheme, formInput, messageOf, request } from '../ui.js';
import { Button, buttonVariants } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import { Card } from '../components/ui/card.js';
import { TooltipProvider } from '../components/ui/tooltip.js';
import { Toaster } from '../components/ui/sonner.js';
import { Brand, Empty } from '../components/common.js';

import { createContext, useContext } from 'react';
import type { Account } from './models.js';
import { Field } from './fields.js';

const SessionContext = createContext<{
  user: Account;
  onLogout: () => void;
  demoUrl: string;
} | null>(null);
export function useSession() {
  const session = useContext(SessionContext);
  if (!session) throw new Error('The dashboard requires an authenticated session.');
  return session;
}
function Auth({
  onSignIn,
  allowSignup,
  github,
  localPassword,
}: {
  onSignIn: (user: Account) => void;
  allowSignup: boolean;
  github: boolean;
  localPassword: boolean;
}) {
  const location = useLocation();
  const [signup, setSignup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(
    new URLSearchParams(location.search).has('error')
      ? 'GitHub sign-in could not complete. Try again or contact the service owner.'
      : '',
  );
  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(true);
    setError('');
    try {
      const input = {
        email: formInput(form, 'email'),
        password: formInput(form, 'password'),
        ...(signup ? { name: formInput(form, 'name') } : {}),
      };
      const result = z.object({ user: publicUserSchema }).parse(
        await request(`/api/auth/${signup ? 'sign-up/email' : 'sign-in/email'}`, {
          method: 'POST',
          body: input,
        }),
      );
      onSignIn(result.user);
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex min-h-dvh items-center justify-center px-6 py-6 sm:py-12">
      <section className="w-full max-w-[360px]">
        <Brand />
        <form onSubmit={(event) => void submit(event)} className="mt-6 grid gap-4 sm:mt-8 sm:gap-6">
          <div>
            <h2 className="text-[28px] font-medium tracking-[-.8px]">
              {signup ? 'Create account' : 'Sign in'}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground [@media(max-height:699px)]:hidden">
              Manage feedback projects, install the toolbar and connect a local coding agent through
              MCP.
            </p>
          </div>
          {github ? (
            <Button
              type="button"
              className="h-10"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void request('/api/auth/sign-in/social', {
                  method: 'POST',
                  body: { provider: 'github', callbackURL: window.location.href },
                })
                  .then((data) => {
                    const response = z.object({ url: z.url() }).parse(data);
                    const destination = new URL(response.url);
                    if (destination.origin !== 'https://github.com')
                      throw new Error('Invalid GitHub sign-in URL.');
                    window.location.assign(destination.href);
                  })
                  .catch((failure: unknown) => {
                    setError(messageOf(failure));
                    setBusy(false);
                  });
              }}
            >
              Continue with GitHub <ArrowUpRight />
            </Button>
          ) : null}
          {localPassword ? (
            <div className="grid gap-5">
              {signup ? (
                <Field label="Name" id="name">
                  <Input
                    id="name"
                    name="name"
                    placeholder="Alex Morgan"
                    autoComplete="name"
                    maxLength={60}
                    required
                    className="h-10"
                  />
                </Field>
              ) : null}
              <Field label="Email address" id="email">
                <Input
                  id="email"
                  name="email"
                  type="email"
                  placeholder="you@example.com"
                  autoComplete="email"
                  required
                  className="h-10"
                />
              </Field>
              <Field label="Password" id="password" hint="At least 12 characters.">
                <Input
                  id="password"
                  name="password"
                  type="password"
                  placeholder="Password"
                  autoComplete={signup ? 'new-password' : 'current-password'}
                  minLength={12}
                  maxLength={200}
                  required
                  className="h-10"
                />
              </Field>
              {error ? (
                <p role="alert" className="text-xs leading-5 text-destructive">
                  {error}
                </p>
              ) : null}
              <Button type="submit" className="h-10" disabled={busy}>
                {busy ? <Loader2 className="animate-spin" /> : null}
                {signup ? 'Create account' : 'Sign in'}
                <ArrowUpRight />
              </Button>
            </div>
          ) : error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </form>
        <footer className="mt-4 flex flex-wrap items-center justify-center gap-x-2 sm:mt-6">
          {allowSignup ? (
            <Button
              variant="link"
              size="xs"
              type="button"
              onClick={() => {
                setSignup(!signup);
                setError('');
              }}
            >
              {signup ? 'Sign in' : 'Create an account'}
            </Button>
          ) : null}
          <a
            href="https://github.com/bentbrain/bent-mono/tree/main/apps/toolbar"
            data-touch-target=""
            className={buttonVariants({
              variant: 'ghost',
              size: 'xs',
              className: 'underline-offset-4 hover:underline',
            })}
          >
            <svg
              aria-hidden="true"
              className="size-4 text-(--bent-color-foreground-light) dark:text-(--bent-color-foreground-dark)"
              viewBox="0 0 16 16"
              fill="currentColor"
            >
              <path d="M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656" />
            </svg>
            Source on GitHub
          </a>
        </footer>
      </section>
    </div>
  );
}
function Consent({
  user,
  onLogout,
  grant,
}: {
  user: Account;
  onLogout: () => void;
  grant: string;
}) {
  const [info, setInfo] = useState<z.infer<typeof consentSchema> | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setInfo(
        consentSchema.parse(
          await request(`/api/connections/approval?code=${encodeURIComponent(grant)}`),
        ),
      );
    } catch (failure) {
      setError(messageOf(failure));
    }
  }, [grant]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 px-6 py-6 sm:gap-8 sm:py-12">
      <Brand />
      <Card className="w-full max-w-md break-words p-5 sm:p-7">
        <div className="grid gap-5">
          <p className="eyebrow">Signed in as {user.name}</p>
          <h1 className="text-2xl font-medium tracking-tight">
            {info?.denied
              ? 'Connection denied.'
              : info?.authorized
                ? 'Connection approved.'
                : info?.kind === 'embed'
                  ? 'Connect this toolbar?'
                  : 'Connect local tools?'}
          </h1>
          {error ? (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <p className="text-xs leading-6 text-muted-foreground">
            {info?.denied
              ? 'Close this window.'
              : info?.authorized
                ? 'Close this window.'
                : info?.kind === 'embed'
                  ? `${info.projectName} on ${info.parentOrigin}`
                  : 'Allow CLI and MCP tools to use your account permissions.'}
          </p>
          <p className="text-xs font-medium">Approval code: {grant}</p>
          <p className="text-xs text-muted-foreground">
            Only approve this code if it matches the code in your toolbar or terminal.
          </p>
          <div className="grid gap-3 rounded-lg border bg-muted/40 p-4 text-xs text-secondary-foreground">
            <span className="flex gap-2">
              <Check className="size-3.5" />
              {info?.kind === 'embed'
                ? 'Participate in this project'
                : 'Create and manage projects'}
            </span>
            <span className="flex gap-2">
              <Check className="size-3.5" />
              {info?.kind === 'embed'
                ? 'Request agent work if you are an owner'
                : 'Read feedback and connect project-scoped agents'}
            </span>
          </div>
          {info && !info.authorized && !info.denied ? (
            <Button
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void request('/api/connections/approve', {
                  method: 'POST',
                  body: { code: grant, accept: true },
                })
                  .then(load)
                  .catch((failure: unknown) => {
                    setError(messageOf(failure));
                  })
                  .finally(() => {
                    setBusy(false);
                  });
              }}
            >
              Approve connection <ArrowUpRight />
            </Button>
          ) : null}
          <Button
            variant="outline"
            disabled={busy || !info || info.authorized || info.denied}
            onClick={() => {
              setBusy(true);
              void request('/api/connections/approve', {
                method: 'POST',
                body: { code: grant, accept: false },
              })
                .then(() => {
                  setInfo((current) =>
                    current ? { ...current, denied: true, authorized: false } : null,
                  );
                })
                .catch((failure: unknown) => {
                  setError(messageOf(failure));
                })
                .finally(() => {
                  setBusy(false);
                });
            }}
          >
            Deny connection
          </Button>
          <Button variant="ghost" onClick={onLogout}>
            Use another account
          </Button>
        </div>
      </Card>
    </div>
  );
}
const consentSchema = z.object({
  kind: z.enum(['embed', 'personal']),
  projectName: z.string().nullable(),
  parentOrigin: z.string().nullable(),
  authorized: z.boolean(),
  denied: z.boolean(),
});

export function SessionBoundary() {
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const update = () => {
      applyTheme(defaultTheme);
    };
    update();
    media.addEventListener('change', update);
    return () => {
      media.removeEventListener('change', update);
    };
  }, []);
  const location = useLocation();
  const grant = new URLSearchParams(location.search).get('user_code');
  const [user, setUser] = useState<Account | null>(null);
  const [ready, setReady] = useState(false);
  const [config, setConfig] = useState({
    demoUrl: 'http://localhost:4311',
    allowSignup: true,
    github: false,
    localPassword: true,
  });
  const [error, setError] = useState('');
  useEffect(() => {
    void (async () => {
      const data = z
        .object({
          demoUrl: z.string(),
          allowSignup: z.boolean(),
          github: z.boolean(),
          localPassword: z.boolean(),
        })
        .parse(await request('/api/config'));
      setConfig(data);
      try {
        setUser(z.object({ user: publicUserSchema }).parse(await request('/api/me')).user);
      } catch {
        /* A new visitor is shown the independent sign-in screen. */
      }
      setReady(true);
    })().catch((failure: unknown) => {
      setError(messageOf(failure));
    });
  }, []);
  useEffect(() => {
    let active = true;
    const check = () => {
      void request('/api/auth/get-session')
        .then((session) => {
          if (!active) return;
          setUser(
            session === null ? null : z.object({ user: publicUserSchema }).parse(session).user,
          );
        })
        .catch(() => {
          /* A network outage retains the current screen until the next check. */
        });
    };
    const timer = setInterval(check, 60_000);
    window.addEventListener('focus', check);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener('focus', check);
    };
  }, []);
  const logout = () =>
    void request('/api/auth/sign-out', { method: 'POST', body: {} })
      .then(() => {
        setUser(null);
      })
      .catch((failure: unknown) => toast.error(messageOf(failure)));
  return (
    <TooltipProvider>
      <Toaster position="bottom-center" richColors />
      {error ? (
        <Empty title="Couldn't open Feedback." description={error} />
      ) : !ready ? (
        <Empty title="Loading…" symbol={<Loader2 className="animate-spin" />} />
      ) : !user ? (
        <Auth
          onSignIn={setUser}
          allowSignup={config.allowSignup}
          github={config.github}
          localPassword={config.localPassword}
        />
      ) : grant ? (
        <Consent key={`${user.id}:${grant}`} user={user} onLogout={logout} grant={grant} />
      ) : (
        <SessionContext.Provider
          key={user.id}
          value={{ user, onLogout: logout, demoUrl: config.demoUrl }}
        >
          <Outlet />
        </SessionContext.Provider>
      )}
    </TooltipProvider>
  );
}
