import Link from "next/link";
import { NewGameForm } from "./NewGameForm";

export default function NewGamePage() {
  return (
    <main className="page-shell narrow-shell">
      <div className="page-topbar"><Link href="/">← 回首頁</Link><span>建立遊戲</span></div>
      <section className="panel setup-panel">
        <p className="eyebrow">NEW GAME</p>
        <h1>建立 12 人狼美人局</h1>
        <p className="muted">你選 1 個座位，其餘 11 席由 Alpha bot 控制。角色會由 Core 在伺服器隨機發牌並鎖定。</p>
        <NewGameForm />
      </section>
    </main>
  );
}
