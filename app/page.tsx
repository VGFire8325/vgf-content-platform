export default function Home() {
  return (
    <main>
      <h1>VGF Content Distribution</h1>
      <p>
        <a href="/review">Go to Review Queue</a>
      </p>
      <h2>Connections</h2>
      <p>
        <a href="/api/oauth/pinterest/start">Connect Pinterest</a>
        {" · "}
        <a href="/api/oauth/meta/start">Connect Facebook &amp; Instagram</a>
      </p>
    </main>
  );
}
