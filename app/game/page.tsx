import Link from "next/link";
import { GameClient } from "./GameClient";

export default function GamePage() {
  return (
    <main className="page-shell game-shell">
      <div className="page-topbar"><Link href="/">狼人殺 AI</Link><span>Web Alpha</span></div>
      <GameClient />
    </main>
  );
}
