"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { PlayerActionPrompt, PlayerView, PublicObservation, PublicSeatView } from "@/src/projection/schemas";
import type { WebActionRequest } from "@/src/web/shared/actionRequest";

type StorageMode = "POSTGRES" | "MEMORY_DEMO";
interface Envelope {
  view: PlayerView;
  storageMode: StorageMode;
  autoAdvance: { steps: number; stoppedForHuman: boolean; terminal: boolean; capped: boolean };
}

const stageLabels: Record<PlayerView["public"]["stage"]["kind"], string> = {
  LOBBY: "大廳",
  LOCKED: "已鎖定角色",
  NIGHT: "夜晚",
  DAWN: "天亮結算",
  SHERIFF: "警長流程",
  DAY: "白天",
  ENDED: "遊戲結束",
  ABORTED: "遊戲中止",
};

function seatLabel(view: PlayerView, playerId: string | null): string {
  if (playerId === null) return "無";
  const seat = view.public.seats.find((entry) => entry.playerId === playerId);
  return seat ? `${seat.seatNumber}號 ${seat.displayName}` : playerId;
}

function timelineText(view: PlayerView, item: PublicObservation): string {
  switch (item.type) {
    case "GAME_STARTED": return "遊戲開始";
    case "NIGHT_STARTED": return `第 ${item.round} 夜開始`;
    case "DAWN": return item.deadPlayerIds.length ? `天亮：${item.deadPlayerIds.map((id) => seatLabel(view, id)).join("、")} 死亡` : "天亮：昨夜平安";
    case "SPEECH": return `${seatLabel(view, item.speakerPlayerId)}：${item.text}`;
    case "SHERIFF_CANDIDATES": return `警長候選：${item.candidatePlayerIds.map((id) => seatLabel(view, id)).join("、") || "無"}`;
    case "SHERIFF_WITHDRAWAL_RESULT": return `退水後候選：${item.remainingCandidatePlayerIds.map((id) => seatLabel(view, id)).join("、") || "無"}`;
    case "VOTE_RESULT": return `${item.voteKind === "DAY" || item.voteKind === "DAY_PK" ? "放逐" : "警長"}投票完成${item.winningTargetId ? `：${seatLabel(view, item.winningTargetId)} 最高票` : "：無結果"}`;
    case "SHERIFF_ELECTED": return `${seatLabel(view, item.playerId)} 當選警長`;
    case "SHERIFF_NO_BADGE": return "本局警徽空缺";
    case "SHERIFF_TRANSFERRED": return `警徽由 ${seatLabel(view, item.fromPlayerId)} 移交給 ${seatLabel(view, item.toPlayerId)}`;
    case "SHERIFF_BADGE_DESTROYED": return `${seatLabel(view, item.holderPlayerId)} 撕毀警徽`;
    case "SELF_EXPLOSION": return `${seatLabel(view, item.playerId)} 自爆`;
    case "HUNTER_SHOT": return `${seatLabel(view, item.hunterPlayerId)} 開槍帶走 ${seatLabel(view, item.targetPlayerId)}`;
    case "DEATHS_REVEALED": return `死亡公布：${item.playerIds.map((id) => seatLabel(view, id)).join("、")}`;
    case "GAME_ENDED": return `遊戲結束：${item.result === "GOOD" ? "好人陣營勝利" : item.result === "WOLF" ? "狼人陣營勝利" : "平局"}`;
    case "GAME_ABORTED": return "遊戲已中止";
  }
}

function PrivateInfo({ view }: { view: PlayerView }) {
  if (!view.identity) return null;
  return (
    <section className="panel private-panel">
      <div className="section-heading"><h2>你的私有資訊</h2><span>只有你能看到</span></div>
      <div className="identity-card">
        <div><span className="mini-label">身份</span><strong>{view.identity.roleDisplayName}</strong></div>
        <div><span className="mini-label">陣營</span><strong>{view.identity.factionId === "WOLF" ? "狼人" : "好人"}</strong></div>
        <div><span className="mini-label">勝利分類</span><strong>{view.identity.victoryBucket}</strong></div>
      </div>
      {view.identity.initiallyKnownIdentities.length > 0 ? (
        <div className="private-list"><strong>你一開始知道：</strong>{view.identity.initiallyKnownIdentities.map((entry) => <span key={entry.playerId}>{seatLabel(view, entry.playerId)} · {entry.roleDisplayName}</span>)}</div>
      ) : null}
      {view.privateObservations.length > 0 ? (
        <div className="private-list"><strong>私密情報：</strong>{view.privateObservations.slice(-8).map((entry) => {
          if (entry.type === "SEER_CHECK") return <span key={entry.ordinal}>第 {entry.nightNumber} 夜查驗 {seatLabel(view, entry.targetPlayerId)}：{entry.result === "WOLF" ? "狼人" : "好人"}</span>;
          if (entry.type === "WITCH_KNIFE_INFO") return <span key={entry.ordinal}>第 {entry.nightNumber} 夜刀口：{entry.status === "TARGET" ? seatLabel(view, entry.targetPlayerId) : entry.status === "NO_ATTACK" ? "無人被刀" : "你已無法取得刀口資訊"}</span>;
          return <span key={entry.ordinal}>第 {entry.nightNumber} 夜狼隊刀口：{entry.status === "TARGET" ? seatLabel(view, entry.targetPlayerId) : "空刀"}</span>;
        })}</div>
      ) : null}
    </section>
  );
}

function SeatNode({ seat, viewerId }: { seat: PublicSeatView; viewerId: string }) {
  const angle = ((seat.seatNumber - 1) / 12) * Math.PI * 2 - Math.PI / 2;
  const style = { left: `${50 + Math.cos(angle) * 43}%`, top: `${50 + Math.sin(angle) * 40}%` };
  return (
    <div className={`seat-node ${seat.lifeState === "DEAD" ? "seat-dead" : ""} ${seat.playerId === viewerId ? "seat-self" : ""}`} style={style}>
      <span className="seat-number">{seat.seatNumber}</span>
      <strong>{seat.displayName}</strong>
      <small>{seat.isSheriff ? "警長" : seat.lifeState === "DEAD" ? "死亡" : seat.controllerType === "NPC" ? "NPC" : "玩家"}</small>
    </div>
  );
}

function GameTable({ view }: { view: PlayerView }) {
  return (
    <section className="panel table-panel">
      <div className="werewolf-table">
        <div className="table-center">
          <span>{stageLabels[view.public.stage.kind]}</span>
          <strong>{view.public.stage.round ? `第 ${view.public.stage.round} 回合` : "準備中"}</strong>
          {view.public.sheriff.holderPlayerId ? <small>警長：{seatLabel(view, view.public.sheriff.holderPlayerId)}</small> : <small>目前無警長</small>}
        </div>
        {view.public.seats.map((seat) => <SeatNode key={seat.playerId} seat={seat} viewerId={view.viewer.playerId} />)}
      </div>
    </section>
  );
}

function TargetButtons({ view, targets, onPick, allowPass, disabled }: { view: PlayerView; targets: readonly string[]; onPick: (id: string | null) => void; allowPass?: boolean; disabled: boolean }) {
  return (
    <div className="target-grid">
      {targets.map((id) => <button key={id} type="button" disabled={disabled} onClick={() => onPick(id)}>{seatLabel(view, id)}</button>)}
      {allowPass ? <button type="button" className="ghost-action" disabled={disabled} onClick={() => onPick(null)}>不使用 / 棄權</button> : null}
    </div>
  );
}

function PromptCard({ view, prompt, submit, busy }: { view: PlayerView; prompt: PlayerActionPrompt; submit: (request: WebActionRequest) => Promise<void>; busy: boolean }) {
  const [speech, setSpeech] = useState("");
  switch (prompt.commandType) {
    case "CommitGuardAction":
      return <ActionBox title="守衛行動" text="選擇今晚守護的玩家。"><TargetButtons view={view} targets={prompt.legalTargetPlayerIds} allowPass disabled={busy} onPick={(targetPlayerId) => submit({ commandType: prompt.commandType, targetPlayerId })} /></ActionBox>;
    case "CommitWolfBallot":
      return <ActionBox title="狼隊刀票" text="選擇今晚的攻擊目標；狼人各自提交一票。"><TargetButtons view={view} targets={prompt.legalTargetPlayerIds} allowPass disabled={busy} onPick={(targetPlayerId) => submit({ commandType: prompt.commandType, targetPlayerId })} /></ActionBox>;
    case "CommitBeautyAction":
      return <ActionBox title="狼美人魅惑" text="選擇本夜魅惑目標，或維持上一夜的魅惑。"><TargetButtons view={view} targets={prompt.legalTargetPlayerIds} disabled={busy} onPick={(targetPlayerId) => targetPlayerId && submit({ commandType: prompt.commandType, mode: "CHARM", targetPlayerId })} />{prompt.modes.includes("KEEP") ? <button className="secondary-button" disabled={busy} onClick={() => submit({ commandType: prompt.commandType, mode: "KEEP", targetPlayerId: null })}>維持原魅惑</button> : null}</ActionBox>;
    case "CommitWitchAction":
      return <ActionBox title="女巫行動" text={prompt.knifeInfo.status === "TARGET" ? `今晚刀口：${seatLabel(view, prompt.knifeInfo.targetPlayerId)}` : prompt.knifeInfo.status === "NO_ATTACK" ? "今晚沒有狼刀目標" : "目前無法取得刀口資訊"}>
        <div className="action-row">{prompt.healRemaining === 1 && prompt.healTargetPlayerId ? <button disabled={busy} onClick={() => submit({ commandType: prompt.commandType, action: "HEAL", targetPlayerId: prompt.healTargetPlayerId })}>使用解藥救 {seatLabel(view, prompt.healTargetPlayerId)}</button> : <span className="disabled-hint">解藥不可用</span>}</div>
        {prompt.poisonRemaining === 1 ? <><p className="mini-label">毒藥目標</p><TargetButtons view={view} targets={prompt.poisonTargetPlayerIds} disabled={busy} onPick={(targetPlayerId) => targetPlayerId && submit({ commandType: prompt.commandType, action: "POISON", targetPlayerId })} /></> : <p className="disabled-hint">毒藥已使用</p>}
        <button className="secondary-button" disabled={busy} onClick={() => submit({ commandType: prompt.commandType, action: "PASS", targetPlayerId: null })}>本夜不用藥</button>
      </ActionBox>;
    case "CommitSeerAction":
      return <ActionBox title="預言家查驗" text="選擇今晚要查驗的玩家。"><TargetButtons view={view} targets={prompt.legalTargetPlayerIds} allowPass disabled={busy} onPick={(targetPlayerId) => submit({ commandType: prompt.commandType, targetPlayerId })} /></ActionBox>;
    case "CommitHunterReaction":
      return <ActionBox title="獵人反應" text="你可以開槍帶走一名玩家，或放棄開槍。"><TargetButtons view={view} targets={prompt.legalTargetPlayerIds} allowPass disabled={busy} onPick={(targetPlayerId) => submit(targetPlayerId ? { commandType: prompt.commandType, action: "SHOOT", targetPlayerId } : { commandType: prompt.commandType, action: "PASS", targetPlayerId: null })} /></ActionBox>;
    case "CommitSpeech":
      return <ActionBox title="輪到你發言" text="這段文字會成為公開發言紀錄。"><textarea value={speech} maxLength={1000} onChange={(event) => setSpeech(event.target.value)} placeholder="輸入你的發言…" /><div className="action-row"><button disabled={busy || speech.trim().length === 0} onClick={() => submit({ commandType: prompt.commandType, mode: "SPEAK", text: speech })}>送出發言</button><button className="secondary-button" disabled={busy} onClick={() => submit({ commandType: prompt.commandType, mode: "PASS", text: null })}>跳過</button></div></ActionBox>;
    case "CommitSheriffSignup":
      return <ActionBox title="警長競選" text="選擇是否上警。"><div className="action-row"><button disabled={busy} onClick={() => submit({ commandType: prompt.commandType, choice: "JOIN" })}>上警</button><button className="secondary-button" disabled={busy} onClick={() => submit({ commandType: prompt.commandType, choice: "PASS" })}>不上警</button></div></ActionBox>;
    case "CommitSheriffWithdrawal":
      return <ActionBox title="退水階段" text="如果你是警長候選人，可選擇留下或退水。"><div className="action-row"><button disabled={busy} onClick={() => submit({ commandType: prompt.commandType, choice: "STAY" })}>留在警上</button><button className="secondary-button" disabled={busy} onClick={() => submit({ commandType: prompt.commandType, choice: "WITHDRAW" })}>退水</button></div></ActionBox>;
    case "CommitBallot":
      return <ActionBox title={prompt.voteKind.includes("SHERIFF") ? "警長投票" : "放逐投票"} text="所有人完成後才會公開完整票型。"><TargetButtons view={view} targets={prompt.legalTargetPlayerIds} allowPass disabled={busy} onPick={(targetPlayerId) => submit({ commandType: prompt.commandType, targetPlayerId })} /></ActionBox>;
    case "ChooseDaySpeechOrder":
      return <ActionBox title="警長指定發言順序" text="選擇第一位發言者及順／逆序。"><div className="order-list">{prompt.legalFirstSpeakerPlayerIds.map((id) => <div className="order-row" key={id}><span>{seatLabel(view, id)}</span><div className="action-row"><button disabled={busy} onClick={() => submit({ commandType: prompt.commandType, firstSpeakerPlayerId: id, direction: "ASC" })}>順序</button><button className="secondary-button" disabled={busy} onClick={() => submit({ commandType: prompt.commandType, firstSpeakerPlayerId: id, direction: "DESC" })}>逆序</button></div></div>)}</div></ActionBox>;
    case "CommitSelfExplosion":
      return <ActionBox title="狼人自爆" text="自爆會立即中止目前白天流程並進入死亡結算。"><button className="danger-button" disabled={busy} onClick={() => submit({ commandType: prompt.commandType })}>確認自爆</button></ActionBox>;
    case "CommitSheriffBadgeAction":
      return <ActionBox title="警徽處理" text="選擇移交警徽，或直接撕毀。"><TargetButtons view={view} targets={prompt.transferTargetPlayerIds} disabled={busy} onPick={(targetPlayerId) => targetPlayerId && submit({ commandType: prompt.commandType, action: "TRANSFER", targetPlayerId })} /><button className="danger-outline" disabled={busy} onClick={() => submit({ commandType: prompt.commandType, action: "DESTROY", targetPlayerId: null })}>撕毀警徽</button></ActionBox>;
  }
}

function ActionBox({ title, text, children }: { title: string; text: string; children: React.ReactNode }) {
  return <div className="action-box"><div><h3>{title}</h3><p>{text}</p></div>{children}</div>;
}

function CurrentTurn({ view }: { view: PlayerView }) {
  const turn = view.public.currentTurn;
  if (turn.kind === "NONE") return <span>系統結算中</span>;
  if (turn.kind === "SPEECH") return <span>{turn.currentSpeakerPlayerId ? `目前發言：${seatLabel(view, turn.currentSpeakerPlayerId)}` : "發言階段"}</span>;
  if (turn.kind === "VOTE") return <span>{turn.voteKind.includes("SHERIFF") ? "警長投票中" : "放逐投票中"}</span>;
  if (turn.kind === "SHERIFF_SIGNUP") return <span>上警登記中</span>;
  if (turn.kind === "SHERIFF_WITHDRAWAL") return <span>候選人退水中</span>;
  if (turn.kind === "DAY_ORDER_SELECTION") return <span>等待警長決定發言順序</span>;
  return <span>等待警長處理警徽</span>;
}

export function GameClient() {
  const [envelope, setEnvelope] = useState<Envelope | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/game", { cache: "no-store" });
      const body = await response.json() as Envelope & { error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "讀取遊戲失敗");
      setEnvelope(body);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "讀取遊戲失敗"); }
    finally { setBusy(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function post(path: string, body?: unknown) {
    setBusy(true); setError(null);
    try {
      const response = await fetch(path, { method: "POST", headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const data = await response.json() as Envelope & { error?: { message?: string } };
      if (!response.ok) throw new Error(data.error?.message ?? "操作失敗");
      setEnvelope(data);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "操作失敗"); }
    finally { setBusy(false); }
  }

  const view = envelope?.view ?? null;
  const timeline = useMemo(() => view ? view.public.timeline.slice(-18).reverse() : [], [view]);

  if (!view) return <section className="panel loading-panel">{busy ? "載入遊戲中…" : <><p>{error ?? "找不到目前遊戲"}</p><Link className="primary-button" href="/new-game">建立新遊戲</Link></>}</section>;

  return (
    <>
      {envelope.storageMode === "MEMORY_DEMO" ? <div className="warning-banner"><strong>本機 Demo 儲存模式</strong><span>目前沒有 DATABASE_URL；本機測試可玩，但部署到 Vercel 前應接 PostgreSQL / Neon。</span></div> : null}
      {envelope.autoAdvance.capped ? <div className="warning-banner">NPC 自動推進達到單次安全上限，可按「繼續推進」接著跑。</div> : null}
      {error ? <div className="error-box">{error}</div> : null}

      <section className="game-header panel">
        <div><p className="eyebrow">GAME {view.public.gameId.slice(0, 8)}</p><h1>{stageLabels[view.public.stage.kind]}{view.public.stage.round ? ` · 第 ${view.public.stage.round} 回合` : ""}</h1><CurrentTurn view={view} /></div>
        <div className={`status-pill status-${view.interactionStatus.toLowerCase()}`}>{view.interactionStatus === "ACTION_REQUIRED" ? "輪到你操作" : view.interactionStatus === "ACTION_SUBMITTED" ? "已送出" : view.interactionStatus === "DEAD" ? "你已死亡" : view.interactionStatus === "GAME_OVER" ? "遊戲結束" : "等待中"}</div>
      </section>

      <div className="game-grid">
        <div className="main-column">
          <GameTable view={view} />
          <PrivateInfo view={view} />
          <section className="panel action-panel">
            <div className="section-heading"><h2>你的操作</h2><span>{view.availableActions.length ? `${view.availableActions.length} 個可用動作` : "目前沒有需要你提交的動作"}</span></div>
            {view.availableActions.length > 0 ? view.availableActions.map((prompt) => <PromptCard key={prompt.commandType} view={view} prompt={prompt} busy={busy} submit={(request) => post("/api/game/action", request)} />) : (
              <div className="waiting-box"><p>{view.public.status === "ENDED" ? "本局已結束。" : view.viewer.publicLifeState === "DEAD" ? "你目前沒有操作權，Alpha bot 可以繼續跑完其他玩家流程。" : "其他玩家或系統正在處理。"}</p>{view.public.status === "IN_PROGRESS" ? <button className="secondary-button" disabled={busy} onClick={() => post("/api/game/advance")}>{busy ? "推進中…" : "繼續推進遊戲"}</button> : null}</div>
            )}
          </section>
          {view.finalReveal ? <section className="panel reveal-panel"><div className="section-heading"><h2>終局翻牌</h2><span>遊戲結束後才公開</span></div><div className="reveal-grid">{view.finalReveal.assignments.map((entry) => <div key={entry.playerId}><strong>{seatLabel(view, entry.playerId)}</strong><span>{entry.roleDisplayName}</span></div>)}</div></section> : null}
        </div>
        <aside className="side-column">
          <section className="panel timeline-panel"><div className="section-heading"><h2>公開紀錄</h2><span>最新在上</span></div><div className="timeline-list">{timeline.length ? timeline.map((item) => <div className="timeline-item" key={item.ordinal}><span>#{item.ordinal}</span><p>{timelineText(view, item)}</p></div>) : <p className="muted">尚無公開事件。</p>}</div></section>
          <section className="panel rules-panel"><h2>本局配置</h2><div className="rules-preview">{view.public.ruleset.roles.map((role) => <span key={role.roleId}>{role.displayName} ×{role.count}</span>)}</div></section>
        </aside>
      </div>
    </>
  );
}
