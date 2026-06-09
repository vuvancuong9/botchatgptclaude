import Link from "next/link";

export default function Home() {
  return (
    <main style={{ maxWidth: 720, margin: "80px auto", padding: 24 }}>
      <h1>AI Orchestrator</h1>
      <p style={{ color: "#9aa7ba" }}>
        A controlled pipeline where ChatGPT and Claude collaborate to build
        software — no infinite chat, max 3 revision rounds, safety guarded.
      </p>
      <p>
        <Link href="/ai-orchestrator">→ Open the orchestrator</Link>
      </p>
    </main>
  );
}
