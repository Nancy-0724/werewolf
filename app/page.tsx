import Link from "next/link";

export default function HomePage() {
  return (
    <main className="landing-shell">
      <section className="landing-card">
        <p className="eyebrow">WEREWOLF · WEB ALPHA</p>
        <h1>12 人狼美人局</h1>
        <p className="lead">1 位真人玩家，11 位規則型 NPC。核心規則、資訊隔離、夜間結算、警長與白天投票都由伺服器裁判。</p>
        <div className="hero-actions">
          <Link className="primary-button" href="/new-game">開始新遊戲</Link>
          <Link className="secondary-button" href="/game">繼續目前遊戲</Link>
        </div>
        <div className="alpha-note">
          <strong>Alpha 範圍</strong>
          <span>目前 NPC 使用 deterministic bot，自動完成技能、發言與投票。下一階段再替換成 AI NPC。</span>
        </div>
      </section>
    </main>
  );
}
