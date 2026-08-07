import { signOut } from "./actions";

export default function Home() {
  return (
    <main>
      <h1>VGF Content Distribution</h1>
      <p>
        <a href="/review">Go to Review Queue</a>
        {" · "}
        <a href="/scheduled">View Scheduled</a>
        {" · "}
        <a href="/assets">Asset Library</a>
      </p>
      <h2>Connections</h2>
      <p>
        <a href="/api/oauth/shopify/start">Connect Shopify</a>
        {" · "}
        <a href="/api/oauth/pinterest/start">Connect Pinterest</a>
        {" · "}
        <a href="/api/oauth/meta/start">Connect Facebook &amp; Instagram</a>
        {" · "}
        <a href="/api/oauth/linkedin/start">Connect LinkedIn</a>
      </p>
      <form action={signOut}>
        <button type="submit">Sign out</button>
      </form>
    </main>
  );
}
