import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

type Architecture = { name: string; nodes: { id: string; name: string; type: string }[] };

const MAX_ATTEMPTS = 20;
const RETRY_DELAY_MS = 500;

function useArchitecture() {
  const [architecture, setArchitecture] = useState<Architecture | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const attempt = async (retriesLeft: number): Promise<void> => {
      try {
        const response = await fetch("/api/architecture", { signal: controller.signal });
        if (!response.ok && retriesLeft > 0) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
          return attempt(retriesLeft - 1);
        }
        if (!response.ok) throw new Error(`Architecture request failed (${response.status})`);
        setArchitecture((await response.json()) as Architecture);
      } catch (reason: unknown) {
        if (controller.signal.aborted) return;
        if (retriesLeft > 0) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
          return attempt(retriesLeft - 1);
        }
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : "Unable to load architecture");
        }
      }
    };
    void attempt(MAX_ATTEMPTS);
    return () => controller.abort();
  }, []);

  return { architecture, error };
}

function App() {
  const { architecture, error } = useArchitecture();

  return (
    <main style={{ maxWidth: 720, margin: "60px auto", padding: 24, fontFamily: "system-ui", color: "#dce7ed", background: "#17232c", borderRadius: 12 }}>
      <p>ARCHMAP · LIVE ARCHITECTURE</p>
      <h1>{architecture?.name ?? "Architecture explorer"}</h1>
      {error && <p role="alert">{error}. Start the local backend and reload.</p>}
      {!architecture && !error && <p role="status">Loading architecture…</p>}
      {architecture && <>
        <p>{architecture.nodes.length} nodes loaded from the local backend</p>
        <ul aria-label="Architecture nodes" style={{ padding: 0, listStyle: "none" }}>
          {architecture.nodes.map((node) => <li key={node.id} style={{ padding: "14px 0", borderBottom: "1px solid #374650", display: "flex", justifyContent: "space-between" }}>
            <strong>{node.name}</strong><span>{node.type}</span>
          </li>)}
        </ul>
      </>}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
