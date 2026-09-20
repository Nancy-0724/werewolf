"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function NewGameForm() {
  const router = useRouter();
  const [displayName, setDisplayName] = useState("Nancy");
  const [seatNumber, setSeatNumber] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createGame(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/games", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName, seatNumber }),
      });
      const body = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "建立遊戲失敗");
      router.push("/game");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "建立遊戲失敗");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="setup-form" onSubmit={createGame}>
      <label>
        <span>玩家名稱</span>
        <input value={displayName} maxLength={24} onChange={(event) => setDisplayName(event.target.value)} required />
      </label>
      <label>
        <span>座位</span>
        <select value={seatNumber} onChange={(event) => setSeatNumber(Number(event.target.value))}>
          {Array.from({ length: 12 }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1} 號</option>)}
        </select>
      </label>
      <div className="rules-preview">
        <span>狼人 ×3</span><span>狼美人 ×1</span><span>預言家 ×1</span><span>女巫 ×1</span><span>獵人 ×1</span><span>守衛 ×1</span><span>平民 ×4</span>
      </div>
      {error ? <p className="error-box">{error}</p> : null}
      <button className="primary-button full-button" type="submit" disabled={busy}>{busy ? "建立中…" : "建立並開始"}</button>
    </form>
  );
}
