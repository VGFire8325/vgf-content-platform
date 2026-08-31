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
        {" · "}
        <a href="/connections">Connections &amp; Policy</a>
      </p>
      <form action={signOut}>
        <button type="submit">Sign out</button>
      </form>
    </main>
  );
}
