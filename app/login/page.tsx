import { requestMagicLink } from "./actions";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; error?: string }>;
}) {
  const { sent, error } = await searchParams;

  if (sent) {
    return (
      <main>
        <h1>Check your email</h1>
        <p>If that&apos;s the right address, a sign-in link is on its way.</p>
      </main>
    );
  }

  return (
    <main>
      <h1>Sign in</h1>
      {error && <p>Something went wrong sending the link. Try again.</p>}
      <form action={requestMagicLink}>
        <label>
          Email
          <input type="email" name="email" required />
        </label>
        <button type="submit">Send magic link</button>
      </form>
    </main>
  );
}
