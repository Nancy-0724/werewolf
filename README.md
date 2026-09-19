# Werewolf Game — C-03 Role Strategy Engine

12 人狼美人板 Web 專案。已完成 A-01～A-05、B Player View、Next.js Web Alpha、C-01 NPC Cognitive State、C-02 Heuristic Reasoning，以及 **C-03 Zero-cost Role Strategy Engine**。

目前產品形態：

```text
1 位真人玩家
+ 11 位 NPC
+ 12 人狼美人板
+ Next.js Web UI
+ Server-only Game Core
+ Player View information boundary
+ NPC Persona / Memory / Belief / Claim / Decision History
+ deterministic C-02 heuristic reasoning
+ deterministic C-03 role strategy
+ PostgreSQL / Neon-ready persistence
+ 0 OpenAI API 費用
```

## 整體架構

```text
Browser
  │
  ▼
Next.js Route Handlers
  ▼
B — Player View
  ├──────────────→ Human UI
  │
  └──────────────→ C NPC Brain
                    ├─ C-01 Memory / Persona / Facts
                    ├─ C-02 Belief / Trust / Suspicion
                    └─ C-03 Role Strategy
                         │
                         ▼
                    fresh PlayerView
                         │
                         ▼
                    A — Game Core
                         │
                         ▼
                PostgreSQL / Neon
```

**Core 仍是唯一裁判。** NPC 只提出策略，真正執行前仍重新取得最新 `PlayerView`，再由 Core 驗證 actor、phase、legal target 與 `windowToken`。

## C-03 現在做什麼？

C-02 回答：

```text
誰比較可疑？
誰比較可信？
目前比較站誰？
```

C-03 把這些分析轉成角色行動：

```text
守衛 → 守誰 / 空守
狼人 → 刀誰 / 如何避開隊友
狼美 → 魅誰 / 是否續魅
女巫 → 救 / 毒 / 保藥
預言家 → 查誰
獵人 → 開槍 / 不開槍
平民/神/狼 → 上警、退水、投票
警長 → 發言順序、警徽移交
狼人 → 在高壓情境下是否自爆
```

全部都是 deterministic TypeScript 規則，不呼叫 OpenAI、LLM、GPU 或外部推理服務。

## 角色策略摘要

### 守衛

- 避免連續守同一人。
- 優先可信、高價值、警長或可信神職宣稱者。
- 不會因為「自己確定自己是好人」就永遠只守自己。

### 狼隊

- 夜刀避開已知狼隊友。
- 優先可信好人、警長、預言家/女巫/守衛/獵人等高價值公開宣稱。
- 白天投票預設避開隊友，優先跟隨可合理辯護的非隊友票型。
- 高 deception Persona 可以做簡單假預言家宣稱。
- 高 aggression/risk Persona 且受到足夠公開壓力時，才考慮自爆。

### 狼美人

- 避開已知狼隊友。
- 優先魅惑高價值好人。
- 已有高價值存活魅惑目標時，可選擇 `KEEP`，避免無意義換魅。

### 女巫

- 首夜合法自救可直接使用。
- 已知狼刀目標是狼時不救。
- 已知狼可直接毒；未知玩家必須達到較高嫌疑門檻才毒。
- 低把握時保留藥，不會每晚必用。

### 預言家

- 避開已經知道陣營的目標。
- 優先查高嫌疑／高資訊量玩家，例如對跳預言家者。
- 白天 deterministic strategic speech 可公開最新合法查驗；C-04 再負責人格化語言風格。

### 獵人

- 確定狼優先開槍。
- 未確定時必須達到嫌疑門檻才開槍。
- 把握不足可以 `PASS`。

## 警長 / 白天策略

- 預言家固定傾向上警。
- 其他角色依 Persona leadership / assertiveness / risk / deception 做上警與退水。
- 好人投票優先最高嫌疑合法目標。
- 狼人在警長選舉會優先支援合法隊友候選人。
- 狼警長死亡時優先把警徽交給合法隊友；好人則優先交可信玩家。
- 警長選發言順序會嘗試從高嫌疑玩家附近開始。

## C-03 的安全邊界

策略引擎只接受：

- `PlayerView`
- C-01/C-02 已持久化的 `NpcCognitiveState`

它不接受：

- raw `GameState`
- raw Event Stream
- SYSTEM_TRUTH
- 其他玩家私密資料
- `windowToken` 持久化

`NpcStrategyDecision` **刻意不包含 `windowToken`**。真正送 Command 時 Web server 才從最新 PlayerView 取得當下 token。

## 決策紀錄

C-03 會把策略寫入既有 `decisionHistory`：

```text
PLANNED
  ↓ Core command success
COMMITTED

PLANNED
  ↓ Core reject
REJECTED
```

這份紀錄只是 NPC 評估資料，不是遊戲真相。Core Event Stream 仍是唯一 authoritative truth。

## Lazy Cognition + Strategy

```text
公開事件持續累積
      ↓
真正輪到 NPC 7 有合法動作
      ↓
C-01 同步新 observation
      ↓
C-02 重新計算 belief
      ↓
C-03 選角色策略
      ↓
重新讀最新 PlayerView capability
      ↓
Core Command
```

不會每出現一條事件就讓 11 個 NPC 全部重算。

## 持久化

遊戲真相：

```text
werewolf_games
werewolf_events
werewolf_command_receipts
werewolf_snapshots
```

NPC 非權威腦內狀態：

```text
werewolf_npc_cognitive_states
```

C-03 沿用 C-01 的 cognitive state JSON，因此**不需要新增 DB migration**。

## 技術基線

- Node.js 24.x
- Next.js 16.3.3 App Router
- React 19.2.8
- TypeScript strict
- Zod 4.6.5
- Vitest 5
- node-postgres 8.23
- PostgreSQL / Neon-ready
- GitHub Actions
- Vercel-ready

## 本機啟動

```bash
npm install
npm run dev
```

本機無 `DATABASE_URL` 時使用 disposable memory demo。

## 正式驗證

```bash
npm run typecheck
npm test
npm run build:core
npm run build
```

## Vercel / PostgreSQL

正式環境設定：

```text
DATABASE_URL
WEB_SESSION_SECRET
```

Migration：

```bash
npm run db:migrate
```

詳見 `docs/VERCEL_DEPLOY.md`。

## 測試定義

```text
A-01    24
A-02    20
A-03    16
A-04    24
A-05    20
B       22
Web      8
C-01    24
C-02    24
C-03    30
------------
Total  212
```

本輪 delivery-external smoke：

```text
C-01  24/24
C-02  24/24
C-03  30/30
```

另以 Web memory-demo 建立多個不同真人座位的遊戲，C-03 NPC 可自動推進並停止在真人決策點。完整正式 Vitest / typecheck / Next build 仍由 GitHub Actions 執行，詳見 `docs/C03-report.md`。

## 主要目錄

```text
app/                              Next.js Web UI / API
src/core/                         A — Game Core
src/projection/                   B — Player View
src/npc/cognition/                C-01 memory / persona / cognitive state
src/npc/reasoning/                C-02 heuristic reasoning
src/npc/strategy/                 C-03 role strategy
src/npc/persistence/              NPC cognition persistence
src/web/                          Web orchestration / C-03 NPC execution
tests/npc/c01.test.ts             C-01 tests
tests/npc/c02.test.ts             C-02 tests
tests/npc/c03.test.ts             C-03 tests
docs/NPC_ROLE_STRATEGY.md         C-03 contract
docs/C03-report.md                C-03 implementation report
```

## 下一階段

**C-04 — Persona Speech Engine**

C-03 已能決定「要表達什麼立場與做什麼」，但目前文字仍是簡單 deterministic strategy template。C-04 會把同一份策略轉成不同 NPC 的語氣、長短、強勢程度、保留程度、真假身份敘事與前後一致性，同樣先維持 **0 OpenAI API 費用**。
