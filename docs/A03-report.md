# A-03 Implementation Report

## Scope

本階段實作夜間效果結算、死亡波、狼美殉情、預言家真實查驗與私密觀察、天亮公告、獵人死亡反應及 ResolutionGroup settled 後的勝負 checkpoint。

## Added commands

- `ResolveNight` (HOST)
- `CommitHunterReaction` (PLAYER)

## Added event families

- StatusApplied / StatusExpired
- SeerCheckResolved
- PrivateObservationPublished
- EffectResolved
- DeathWaveResolved
- DawnAnnouncementPublished
- ReactionWindowOpened / ReactionCommitted / ReactionClosed
- ResolutionGroupSettled
- GameEnded

## A-03 acceptance tests

`tests/core/a03.test.ts` contains A03-01～A03-16，涵蓋：

- 守衛單獨防刀
- 解藥單獨救人
- 同守同救
- 多重死因合併
- 狼美魅惑殉情
- 預言家 truth/private observation
- 公開天亮死訊資料最小化
- 獵人狼刀死亡可開槍
- 同守同救可開槍
- 中毒不可開槍
- 魅惑殉情不可開槍
- PASS
- 槍擊後續 DeathWave
- 槍殺狼美觸發魅惑
- A-03 邊界停在 DAWN_READY_FOR_DAY
- ResolveNight command idempotency

## Verification performed in this environment

正式 `npm install` 因 npm registry 連線逾時，無法在此容器完成正式 Vitest / strict TypeScript dependency stack 驗證，因此未標示正式 PASS。

為抓取 A-03 執行期邏輯錯誤，建立了**不納入交付物**的臨時 Zod compatibility shim，使用 TypeScript `--noCheck` emit 後實際執行三個高風險 smoke scenarios：

1. 同守同救獵人死亡 → reaction window 開啟 → PASS 後 settled。
2. 獵人被毒 → 不產生 hunter reaction。
3. 獵人先被狼刀死亡、再開槍射死狼美 → 當前魅惑目標於後續 DeathWave 殉情。

結果：全部 PASS。

交付 ZIP 已移除臨時 `node_modules`、shim、smoke build 與執行腳本。
