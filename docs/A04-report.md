# A-04 Implementation Report

## Scope

A-04 將 A-03 的 `DAWN_READY_FOR_DAY` 接成完整白天流程，並在白天結束後建立下一夜，使核心能持續日夜循環。A-04 重用 A-03 的 ResolutionGroup / DeathWave / Hunter / victory checkpoint，不建立第二套死亡邏輯。

## Added commands

- `BeginDay` (HOST)
- `CommitSpeech` (PLAYER)
- `CommitSheriffSignup` (PLAYER)
- `CommitSheriffWithdrawal` (PLAYER)
- `CommitBallot` (PLAYER)
- `ChooseDaySpeechOrder` (PLAYER / active sheriff)
- `CommitSelfExplosion` (PLAYER / living wolf)
- `CommitSheriffBadgeAction` (PLAYER / dead badge holder)

## Added event families

- `NightStarted`
- `SpeechSessionOpened / SpeechPublished / SpeechFinished`
- `SheriffSignupSessionOpened / Committed / Closed`
- `SheriffWithdrawalSessionOpened / Committed / Closed`
- `VoteSessionOpened / BallotCommitted / VoteSessionResolved`
- `SheriffElected / SheriffElectionClosedNoBadge`
- `SheriffTransferred / SheriffBadgeDestroyed`
- `ResolutionGroupOpened`
- `SelfExplosionCommitted`

`EffectResolved` 也新增日間 `VOTE_EXECUTION` 與 `SELF_EXPLOSION` 類型。

## State / phase expansion

新增主要 phase：

- `LAST_WORDS`
- `SHERIFF_SIGNUP`
- `SHERIFF_SPEECH`
- `SHERIFF_WITHDRAWAL`
- `SHERIFF_VOTE`
- `SHERIFF_PK_SPEECH`
- `SHERIFF_PK_VOTE`
- `DAY_ORDER_SELECTION`
- `DAY_DISCUSSION`
- `DAY_VOTE`
- `DAY_PK_SPEECH`
- `DAY_PK_VOTE`
- `DAY_RESOLUTION`
- `DAY_HUNTER_REACTION`
- `SHERIFF_BADGE_ACTION`

並加入 typed `SpeechSession`、`VoteSession`、Sheriff signup/withdrawal session。

## Important rule decisions implemented

1. 警長原始選民在 signup 結束時固定；退水不取得選票。
2. 單一候選人直接當選；0 候選人直接無警徽。
3. 警長選舉最多一輪 PK；第二次平票或全棄票後無警徽。
4. 警長競選 vote weight 全部 2 units。
5. 白天放逐：普通 2 units、警長 3 units，數值取自 ruleset snapshot。
6. 白天 PK 候選人不能投票。
7. 所有 ballots 完成前，不產生 PUBLIC 完整票型。
8. 狼人合法發言階段可隨時自爆，不限當前 speaker。
9. 警長競選期間自爆使該局選舉永久 `NO_BADGE`。
10. 正式放逐與自爆沿用 DeathWave；勝負仍只在 ResolutionGroup settled 後判定。
11. 第一夜死亡與正式白天放逐才有遺言；其他死亡來源沒有。
12. 死亡警長在未終局時必須移交或撕毀警徽。
13. N2 之後死亡神職自動略過對應夜間窗口，避免完整循環卡死。

## A-04 acceptance tests

`tests/core/a04.test.ts` contains A04-01～A04-24，涵蓋：

- 天亮進警長選舉
- 第一夜遺言
- 單一候選人直接當選
- 無候選人
- 退水不取得警下票
- 警長選舉 2-unit 權重
- 警長平票 PK
- 警長選發言順序、警長最後發言
- 白天警長 3-unit 權重
- 白天平票 PK、候選人不能投票
- 第二次白天平票不放逐
- 正式放逐 DeathCause + 遺言
- 發言宣稱身份不改角色
- 非當前 speaker 狼人自爆
- 競選期間自爆取消警長選舉
- 死亡警長移交／撕毀警徽
- 死亡夜間角色 N2 自動跳過
- 全員上警造成無原始選民
- 獵人白天被放逐先開反應再遺言
- 第二夜死亡警長先處理警徽再進白天
- 警長第二次 PK 平票後無警徽
- replay 拒絕偽造的白天票重 snapshot
- replay 拒絕偽造的無警長白天發言順序

累計 test definitions：A-01 24 + A-02 20 + A-03 16 + A-04 24 = 84。

## Verification performed in this environment

正式 `npm install` 在 30 秒驗證窗口內逾時，因此無法安裝 declared Zod/Vitest/TypeScript dependency stack；正式 `npm test` / strict `npm run typecheck` / `npm run build` 不在此容器標記 PASS。

為執行 A-04 邏輯，使用 **repository 外、交付 ZIP 不包含** 的 temporary TypeScript emit + minimal compatibility shims：

- A04-01～A04-24：24/24 PASS。
- A02-01～A02-20：20/20 regression PASS。
- A03-01～A03-16：16/16 regression PASS。

A-01 使用較多 Zod strict-schema 行為，minimal shim 無法忠實模擬 unknown-key error semantics，因此未用該 shim 宣稱 A-01 全套正式回歸；A-01 test file 未刪除或弱化。GitHub Actions 會在真正依賴環境執行全部 84 個 test definitions。

另外完成 TypeScript no-check emit syntax validation，以及交付前禁止項目掃描。臨時 shim、`node_modules`、emit output、smoke scripts 均不放入交付 ZIP。
