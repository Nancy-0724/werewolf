# Werewolf A Core — A-01

狼人殺 App 的第一個可信核心里程碑。這個 repository **不是可玩的 App**；目前只實作 A-01：

`建局 → 配置 12 座位 → 一次隨機分配並鎖定身份 → append-only events → replay → JSON 匯出/匯入`

另支援 HOST 在 `LOBBY` 或 `LOCKED` 中止遊戲，且保留既有歷史與已鎖身份。

## 技術基線

- Node.js 24.x LTS（`.nvmrc` 固定 24.21.0）
- TypeScript strict
- Zod runtime schemas
- Vitest
- npm

## 安裝與驗證

```bash
npm install
npm run typecheck
npm test
npm run build
```

目前交付環境無法連線 npm registry，因此沒有偽造 `package-lock.json`，正式 Vitest 驗證需在可連 npm 的環境執行。交付前另以 repository 外的臨時相容 shim 執行同一份 T01–T24 測試邏輯，結果為 24/24；詳細限制與實際命令見 `docs/A01-report.md`。

> 此 repo 依 A-01 規格使用記憶體 repository。JSON export/import 是開發與 SYSTEM_TRUTH 備份格式，不是玩家/觀戰 API，也不代表已具備自動抗當機持久化。

## 已實作

- 固定 ruleset `wolf-beauty-12.app@1.0.0`
- 12 人 WB12 角色/房規完整 snapshot 驗證
- `CreateGame` / `ConfigureSeats` / `LockGame` / `AbortGame`
- `GameCreated` / `SeatsConfigured` / `SetupLocked` / `GameAborted`
- TrustedPrincipal HOST 授權契約
- Command receipt/idempotency
- Fisher–Yates + injectable RNG
- Pure reducer/replay
- Optimistic concurrency (`expectedSequence`)
- Atomic append
- JSON export/import + stream/receipt validation
- T01–T24 A-01 驗收測試

## 明確未實作

- UI / React / PWA
- API routes / login / account security
- GameStarted / 第一夜
- 角色技能、死亡結算、警長、投票、發言
- Player View / SYSTEM_TRUTH 對玩家的 projection
- NPC / LLM / 記憶 / 推理
- 自動持久化、database、snapshot recovery

## 目錄

```text
src/core/domain/          schemas、errors、JSON utilities、pure reducer
src/core/rulesets/        WB12_APP_v1 固定規格 snapshot
src/core/application/     command service、ports
src/core/infrastructure/  memory repository、Node adapters
src/core/serialization/   truth bundle export/import
tests/core/               T01–T24
docs/                     architecture、decisions、A01 report、原始規格
```

完整設計來源保留於 `docs/spec-source/`。後續里程碑必須依規格逐步做，不在 A-01 順手加入 A-02。
