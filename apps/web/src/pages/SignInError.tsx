import { PageHeader, Card } from './common';

const MESSAGES: Record<string, { title: string; detail: string }> = {
  denied: { title: 'Your account has no access to the platform', detail: 'You signed in successfully, but you are not a member of any group that grants a role. Ask an Administrator to add you to the right group, then sign in again.' },
  unavailable: { title: 'The sign-in service is unavailable', detail: 'We could not reach the identity provider. Try again in a moment, and tell an Administrator if it keeps happening.' },
  failed: { title: 'Sign-in did not complete', detail: 'The sign-in attempt expired or was cancelled. Start again to continue.' },
};

export function SignInError({ code }: { code?: string }) {
  const m = MESSAGES[code ?? 'failed'] ?? MESSAGES.failed!;
  return (
    <main className="mx-auto max-w-lg p-6 pt-24">
      <PageHeader title={m.title} />
      <Card label="Sign-in problem">
        <p>{m.detail}</p>
        <p className="mt-4">
          <a href="/api/v1/auth/login" className="rounded-md bg-blue-700 px-4 py-2 text-white hover:bg-blue-800">
            Sign in again
          </a>
        </p>
      </Card>
    </main>
  );
}
