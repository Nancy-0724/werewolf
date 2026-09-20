# 狼人殺 App — A：規則核心、狀態與事件規格 v1.0

文件狀態：供第一階段實作的設計基準；不是已完成的程式。
文件日期：2026-09-19
第一個實作里程碑：A-01（僅建局、座位、鎖牌、事件儲存與重播）。

## 0. 適用範圍與優先次序

本文件整合並修正先前 A、A-2 的草案。相同事項有衝突時，以本文件為準；不要混用聊天中舊的欄位名稱或事件名稱。

這份文件定義的是本 App 的房規，不宣稱是各平台通用的「官方標準」。房規尚未開局可以選擇；鎖局後不得變更。此文件不重建、不補寫先前聊天局未曾真正保存的隱藏身份。

完整 A 層包括規則核心、狀態、事件、技能結算、勝負、持久化與重播。A-01 只是 A 層的第一小部分。收到 A-01 prompt 的 coding AI，不得因本文件描述了後續功能就一次全部實作。

不在 A 的實作範圍：NPC推理、信念機率、人格、LLM呼叫、Player View完整編譯器、語音、介面、帳號、線上多人。

## 1. 不可破壞的核心契約

1. 正式行動流程是：可信身分上下文 + Command → 驗證 → 產生 Event batch → 原子保存 → 純 Reducer 投影 State。
2. 真人與NPC使用相同遊戲Command與規則；只有控制來源不同。
3. `assignedRoleId` 只在鎖局時寫入一次。v1沒有轉化角色，任何改身份行動一律拒絕。
4. 真相儲存層只有受信任規則核心可以讀。玩家、NPC、共用畫面不取得原始truth state或原始event stream。
5. 發言內容不產生身份確認。`SpeechPublished("我是女巫")` 只代表有人說過這句話。
6. Ruleset中的文字描述不是可執行規則。技能必須由已註冊、版本固定的handler執行。
7. Reducer不呼叫LLM、RNG、時鐘、網路或資料庫；不重新計算歷史技能效果。
8. 事件只能新增。錯誤不能靠改舊log掩蓋；開發除錯建立獨立分支，正式局嚴重異常暫停或中止。
9. Snapshot是快取，不是真相來源。事件可完整重建狀態。
10. 發生死亡連鎖時，在完整結算群組settled之前，不宣告勝負。
11. 真相事件、公開資訊、指定收件人的私密資訊分離；visibility字串本身不是存取控制。
12. 不同NPC可以合理得出相同結論，也可以猜中答案；防作弊目標是禁止非法資訊輸入，不是強迫分歧、禁止正確推理或保證玩家獲勝。

## 2. 第一個板子與角色範圍

`rulesetId = wolf-beauty-12.app`
`rulesetVersion = 1.0.0`
`engineContractVersion = 1.0.0`

| roleId | 名稱 | count | factionId | victoryBucket | 能力 |
|---|---|---:|---|---|---|
| WEREWOLF | 普通狼人 | 3 | WOLF | WOLF | 狼隊夜聊、共同狼刀、白天自爆 |
| WOLF_BEAUTY | 狼美人 | 1 | WOLF | WOLF | 普通狼人能力、魅惑、死亡連動 |
| SEER | 預言家 | 1 | GOOD | GOD | 夜間陣營查驗 |
| WITCH | 女巫 | 1 | GOOD | GOD | 一瓶解藥、一瓶毒藥 |
| HUNTER | 獵人 | 1 | GOOD | GOD | 符合死因的死亡開槍 |
| GUARD | 守衛 | 1 | GOOD | GOD | 夜間守護 |
| VILLAGER | 平民 | 4 | GOOD | VILLAGER | 無角色專屬技能 |

GOOD陣營共8人，WOLF共4人。WOLF_BEAUTY查驗結果為WOLF。角色是否屬於神職由victoryBucket明確定義，不能靠「有技能」猜測。

狼人初始知道自己的身份、狼隊成員，以及本板子允許隊內共享的特殊狼身份；不知道其他人的神職或平民身份。某人跳預言家不等於狼隊已被系統確認他是真預言家。

v1不實作狼王、白痴、騎士、機械狼、石像鬼、夢魘、丘比特、感染或換牌。可以在產品路線圖列出，但不得顯示成可玩的功能。

## 3. 本 App v1 預設房規

以下是具體選定的設計，不引用其他平台作為隱含規則。

### 3.1 警長、投票、白天

| 項目 | v1預設 |
|---|---|
| 上警 | 開啟；第一夜結算、死訊與死亡技能處理完畢後競選 |
| 警上報名 | 所有當時存活玩家各選一次；全部提交前不公布名單 |
| 退水 | 發言後有統一退水窗口；退水後不得重新加入本輪 |
| 警長投票資格 | 報名截止時原本未上警、且投票時仍存活的玩家 |
| 退水後投票 | 不可以；不能因退水自動變成有票的警下玩家 |
| 警長PK投票 | 沿用原始警下選民集合，移除不再存活者 |
| 警長平票 | 最多一次PK；再平票或全棄票則無警長 |
| 無候選人／無有效選民 | 無警長；只有一名候選人時直接當選，先於無選民規則判定 |
| 放逐投票 | 全部存活玩家；允許棄票、允許投自己 |
| 放逐PK | 平票候選人不得投票，其餘存活玩家投票；再平票或全棄票不放逐 |
| 票重 | 警長選舉所有人1票；白天放逐警長1.5票，其他人1票 |
| 程式計票 | 以整數units保存：普通票2、警長放逐票3；畫面顯示units/2 |
| 提交後改票 | v1不允許。確認前UI可以改草稿；提交後鎖定 |
| 公布票型 | 所有有資格者提交／合法棄票後一次公布，不揭露即時票數 |
| 警長發言 | 選非警長的首位與順／逆序，其餘存活者各一次，警長最後 |
| 無警長發言 | 存活玩家依座號遞增 |
| 警徽移交 | 持有者死亡，結算群組完成且遊戲未結束時，移交給存活者或撕毀 |
| 身份揭露 | 一般放逐、夜死不翻牌；已發動且規則要求揭露的技能、自爆例外 |

原聊天把退水者算進警長選民，以及後續忽略警長1.5票，不能帶入本規格。首夜先公布死訊再競選是本App的簡化房規；不是其他平台的默認順序。

### 3.2 狼刀與狼美人

狼人每夜先私聊，再由每名當夜有資格的存活狼人提交一張刀票。可選任一夜初存活玩家，包括自己或隊友，也可棄刀。計入棄刀選項後，唯一最高票選項成為結果；最高票並列則當夜棄刀。提交前可商議，提交後不能改。

沒有指定「人類玩家自動具有最終決定權」。真人與NPC同票權；未來若新增狼隊隊長制，另立版本。

狼美人每夜可選一名其他夜初存活玩家，或選擇保留目前魅惑。允許連續魅惑同一人、魅惑隊友；禁止魅惑自己。首夜保留表示沒有目標。

新魅惑在夜間死亡計算前生效；即使狼美人同夜死亡，使用本夜新目標。新魅惑覆蓋舊目標，不能同时保留兩條有效連結。保留不會重新施加已失效連結。

狼美人因狼刀、毒、放逐、槍擊、自爆死亡，都觸發當前有效魅惑。目標已於更早結算波死亡，不追加第二次死亡。目標死亡不反向殺狼美人。守護、解藥不能抵銷殉情。

白天觸發魅惑死亡時，公開來源與連動目標；夜間觸發時，天亮只公布總死亡名單，不公開因果。

### 3.3 女巫

每局解藥一瓶、毒藥一瓶；同一夜最多使用一瓶。一次提交一個完整女巫行動：PASS / HEAL / POISON，避免兩個平行請求繞過不能雙藥。

解藥只能救當夜實際狼刀目標。首夜可自救，第二夜起不能自救。女巫自己吃刀仍可在當夜使用毒藥；夜初活著且具備行動資格即可，不能因稍後將死而提前取消。

v1預設 `knifeInfoMode = WHILE_HEAL_REMAINS`：本夜資訊窗口開啟時仍持有解藥，才得到狼刀目標；用完解藥的之後夜晚不再得知。後續可新增明確選項 `ALWAYS`，重現原聊天中「藥用完仍報刀口」房規；在對應版本與測試完成前不開放，不得暗中切換。

女巫知道的是「攻擊目標」，不是其陣營，也不是保護結算後必死者。守衛是否守中不告知女巫。沒有狼刀时私密通知NO_ATTACK；没有資訊權限時通知UNAVAILABLE，兩者不得混用。

毒藥可選任何其他夜初存活玩家，不能毒自己。不受守護或解藥解除。合法提交時扣藥，稍後被保護／其他原因先死不退藥；非法或重複command不扣藥。

### 3.4 守衛、預言家、獵人

守衛：可守自己、可空守，不能連續兩夜守同一人。「連續」按夜次判斷，不能只比較歷史最後一次非空目標。N1守A、N2空守、N3守A合法。守護只抵擋狼刀，不擋毒、槍、殉情或放逐。

預言家：每夜可查一名其他夜初存活玩家，也可不查。允許重複查驗。本板子查驗可靠，只回GOOD/WOLF，結果只交給本人。在當夜死亡結算前發出，因此當夜死亡不撤銷已獲得的結果。

獵人：符合條件死亡後有一次開槍或放棄機會，只能射仍存活的其他玩家。狼刀、放逐、獵人槍擊、同守同救導致的死亡允許開槍；死因集合包含毒或魅惑殉情則禁止。本板子只有一名獵人，仍使用通用死亡反應窗口。

有效開槍公開獵人身份及目標。未發槍或不能開槍，不額外公開獵人身份／禁槍死因。合法死亡反應使用專屬reactionToken，不能被「死者不得操作」的一般檢查錯擋。

### 3.5 保護與死亡結果表

同守同救指：同一名狼刀目標同夜受到守護與解藥，該目標仍死亡。沒有狼刀時不存在合法解藥目標，不會憑空造成碰撞死亡。

| 攻擊／效果 | 結果 |
|---|---|
| 狼刀 | 死亡 |
| 狼刀 + 守護 | 存活 |
| 狼刀 + 解藥 | 存活 |
| 狼刀 + 守護 + 解藥 | 死亡，記GUARD_HEAL_COLLISION |
| 毒 + 守護 | 死亡 |
| 狼刀 + 解藥 + 毒 | 毒死；解藥仍消耗 |
| 殉情 + 守護 | 死亡 |
| 狼刀 + 毒且未被抵擋 | 一次死亡、兩個有效死因；獵人不能開槍 |

### 3.6 自爆、遺言、死亡觀戰

自爆只允許活著的狼人，在SHERIFF_SPEECH、SHERIFF_PK_SPEECH、DAY_DISCUSSION、DAY_PK_SPEECH窗口提交；不要求當下正在發言。投票、遺言、死亡反應、技能結算窗口禁止。

自爆確認後立即阻止新的發言與投票提交，依完整死亡連鎖結算。遊戲仍未結束才進下一夜；不能跳過殉情、必要死亡反應或警徽處理。

警長競選發言時自爆：本次競選中止，v1本局不再重啟競選，警徽狀態NO_BADGE。已有警長的白天自爆不自動清空警徽，依持有者是否死亡處理。

首夜死亡者及白天正式放逐者有遺言。後續夜死、槍殺、殉情、自爆均無遺言。多種原因同波死亡時，只有符合遺言來源且沒有明確禁言來源者能遺言。技能先結算；遊戲已終局直接進終局展示，不再開遊戲內遺言／警徽操作。

死者只看公開進度，不參與任何普通行動，不再收到之後新產生的狼隊私聊。有效死亡技能與警徽處理是有限例外。完整底牌與夜間資料只在終局揭露或隔離的開發工具可見。

### 3.7 勝利與同時達標

預設屠邊：
- GOOD条件：存活狼人數為0。
- WOLF条件：存活GOD數為0，或存活VILLAGER數為0。
- 不使用「狼數大於或等於好人數」作為額外勝利條件。

只在ResolutionGroup所有必然死亡與合法死亡反應處理完後判定。只有一方條件成立則該方勝；兩方在同一檢查點都成立則DRAW；都不成立則繼續。

例如最後狼美人死亡且殉情帶走最後神職，本v1判平局。其他版本可採不同優先序，但必須新ruleset，不能依事件寫入先後臨場決定。

### 3.8 房規擴充邊界

第一個可玩引擎只承諾本文件的完整預設。以下列的是後續候選房規，不是v1已支援功能；每一種替代值都需補足語義、規則版本與測試後才可出現在UI：
- sheriff.enabled：true / false。
- witch.knifeInfoMode：WHILE_HEAL_REMAINS / ALWAYS。
- witch.firstNightSelfSave：true / false。
- guard.allowSelf：true / false。
- guard.allowConsecutiveTarget：true / false。
- guard.healCollision：KILL / SURVIVE。
- beauty.allowConsecutiveTarget：true / false。
- beauty.allowWolfTarget：true / false。

目前所有房規都是v1固定值，不設一堆尚未支援的開關。例如不能雙藥、禁止自魅、屠邊、同時達標平局、狼美人允許自爆均固定。A-01只接受本文件預設值；替代值另交付小里程碑。特別是禁止連魅時「保留上一夜魅惑」該如何處理，必須連同PASS語義一起訂定，不能只翻轉一個boolean就聲稱完成。

## 4. 資料定義與程式handler的分工

### 4.1 RoleDefinition

必要欄位：roleId、roleVersion、displayName、factionId、victoryBucket、abilityRefs、initialKnowledgePolicyId。

RoleDefinition描述角色；RoleAssignment描述某玩家拿到哪張牌。不得將具體座位寫在角色定義。

### 4.2 AbilityDefinition

必要欄位：abilityId、abilityVersion、ownerKind(PLAYER/TEAM)、activationWindow、triggerKind(ACTIVE/PASSIVE)、targetPolicyId、resourcePolicyId、effectHandlerId、informationPolicyId、supportedRuleOptions。

類似「預言家查驗」和「機械狼學習」即使都選一個人，效果也不能只用通用文字metadata表達。新角色如需要新機制，新增版本化handler與測試，不讓LLM臨場解釋。

### 4.3 Handler契約

validate：依規則、行動窗口、合法目標、資源檢查Command，回傳結構化錯誤或已驗證意圖。
planEffects：依該次結算快照及已鎖定意圖，回傳Effect資料，不直接改state。
projectObservation：產生應交付的資訊及固定收件人；完整Player View組裝留給B。

所有handler不得自行存檔、呼叫LLM、讀NPC信念、依玩家是不是主角改規則。

Registry必須採白名單。未知roleId、handlerId、版本或不支援的房規組合，在鎖局前拒絕。禁止eval、自動下載執行ruleset中的程式、以任意any/metadata跳過驗證。

## 5. 狀態結構整合版

所有持久化資料使用可序列化JSON：無function、Map、Set、Date實例、undefined、NaN或Infinity。日期使用UTC ISO字串；遊戲先後依sequence，不依時間字串。

### 5.1 GameState

欄位：gameId、status、createdAtIso、lastSequence、lobby、manifest、lockedSetup、runtime、abortReason。abortReason正常時為null，中止時記錄版本化原因碼；A-01只支援HOST_REQUEST。

status：LOBBY / LOCKED / IN_PROGRESS / ENDED / ABORTED。

LOBBY：lobby有值，manifest、lockedSetup、runtime為null。
LOCKED：lobby為null，manifest與lockedSetup有值，runtime為null。
IN_PROGRESS：runtime有值。
ENDED：保留最後狀態與結果；不再接受普通行動。
ABORTED：保留先前已存在資料與中止原因；不偽造勝方。

events、commandReceipts、snapshots存在Repository中，不重複嵌入GameState。

### 5.2 LobbyConfig與GameManifest

LobbyConfig：seats、rulesetDraft。A-01只有完整替換座位配置，不做增量座位編輯；修改房規需要建立新局，暫不做UpdateRuleset命令。

Seat：playerId(不透明ID)、seatNumber(1..12)、displayName、controllerType(HUMAN/NPC)。座號與playerId分開。

GameManifest在SetupLocked事件建立，之後不可變：gameId、dataSchemaVersion、engineContractVersion、engineBuildId、createdAtIso、lockedAtIso、seatsSnapshot、rulesetSnapshot。

rulesetSnapshot包含角色配置、確切房規與使用的角色／技能版本清單。Public配置不放角色分配或抽牌seed。startedAt、endedAt、目前警長等變動欄位不放immutable manifest。

### 5.3 LockedSetup

assignments：每玩家一筆playerId、assignedRoleId、assignedFactionId、victoryBucket、assignedAtSequence。

assignmentAudit：randomAlgorithmId、privateSeed(可null)。不要求一般隨機源提供seed；重播靠已存分配結果。固定seed只用於受控測試或秘密除錯，不得送玩家。

整個LockedSetup為SYSTEM_TRUTH。Assigned faction與bucket必須和鎖定角色目錄一致。

### 5.4 RuntimeState（A-01不實作）

phase、round、players、abilityStates、statusEffects、nightSession、speechSession、voteSession、sheriff、resolutionGroup、pendingReactions、outcome、startedAtIso、endedAtIso。

PlayerRuntime：playerId、lifeState(ALIVE/DEAD)、deathRecordId、effectiveRoleId、effectiveFactionId。本v1有效身份等於Assigned身份，不允許轉化事件。

canSpeak、canVote、legalTargets透過目前phase與玩家狀態推導，不設獨立可寫真相欄位。

### 5.5 AbilityState

使用有類型的union，不使用無約束metadata。
- Witch：healRemaining(0/1)、poisonRemaining(0/1)、lastActionNight與本夜提交狀態。
- Guard：lastNightNumber、lastTargetPlayerId(允許null空守)。
- Beauty：activeCharmStatusId(可null)、lastCharmNight。
- Hunter：shotRemaining(0/1)、reactionStatus。
- Seer：lastActionNight；歷史查驗保存在事件／本人私密觀察，不只存最後一次。
- WolfTeam：本夜刀票session與已鎖定knifeTarget(可null)。

### 5.6 Phase與Session

PhaseState：phaseId、phaseType、roundNumber、openedAtSequence、status、continuation。
Session：sessionId、phaseId、eligibleActorsSnapshot、legalTargetsSnapshot、committedActors、status。

發言／投票／夜間技能／死亡反應使用獨立session，不以一個全域currentSpeaker概括全部流程。

Continuation保存死亡連鎖後要恢復的合法流程。自爆把continuation設定NEXT_NIGHT；沒有自爆则回到原流程。不得遞迴呼叫後遺失狀態。

### 5.7 StatusEffect

statusId、type、sourcePlayerId、targetPlayerId、appliedAtSequence、scope、expirationPolicy、active。

PROTECTED只屬於當夜；CHARMED持續至替換、目標死亡或來源死亡結算完成。不得把未知未來的expiresAtSequence當作排程。用AT_NIGHT_END、UNTIL_REPLACED等明確條件。

### 5.8 DeathRecord

deathId、playerId、resolutionGroupId、waveId、round、causes[]、sourceEffectIds[]、deathEventSequence。

causes白名單：WEREWOLF_ATTACK / WITCH_POISON / VOTE_EXECUTION / HUNTER_SHOT / WOLF_BEAUTY_LINK / GUARD_HEAL_COLLISION / SELF_EXPLOSION。

同一波死亡先計算完整原因集合再建立DeathRecord。公開死因不是此record的欄位；公開資訊另外發布。

### 5.9 Vote與Sheriff

VoteSession：sessionId、kind、roundIndex、eligibleVotersSnapshot、eligibleTargetsSnapshot、weightUnitsByVoter、ballots、status、result。

Ballot：voterPlayerId、targetPlayerId(null為棄票)、committedAtSequence。名單與票重在session開始時固定。投票session不允許自爆，所以中途不改票重。

Result：tallyUnitsByTarget、abstainedPlayerIds、tiedPlayerIds、winningTargetId、resolutionKind。

Sheriff：enabled、holderPlayerId、badgeStatus(UNASSIGNED/ACTIVE/NO_BADGE/DESTROYED)、electionAttempted、electedAtSequence。

### 5.10 Speech

SpeechPublished保存speaker、sessionId、原始text、source(HUMAN_TEXT/HUMAN_TRANSCRIPT/NPC_TEXT)、publishedAtSequence。原文不可偷偷改寫。

真人語音轉字若需修正，以新的更正事件表達並保留原文；未來混合模式不能只有「按下發言結束」而無可供NPC讀取的發言內容。

## 6. Command、身份與並行控制

玩家可提交的CommandEnvelope：commandId、gameId、actorPlayerId(或host command用null)、commandType、payload、windowToken(設置期可null)。這些是請求資料，不代表已獲授權。

TrustedPrincipal由受信任入口提供，不可相信payload中的source=SYSTEM。正式API必須驗證玩家與座位關係；A-01僅內部HOST/PLAYER測試上下文，不聲稱已完成登入或網路安全。

正式流程：驗證身分 → 檢查同commandId的receipt → 驗證內容與窗口 → 讀狀態 → 執行規則 → 使用repository內部expectedSequence原子append。

同commandId同內容與同principal重送：回原成功receipt，不新增事件、不重新抽牌。
同commandId不同內容或principal：COMMAND_ID_REUSED。
不相同commandId但重複鎖局／已提交行動：拒絕。
並行時expectedSequence不符：CONCURRENCY_CONFLICT；重新讀取後重新驗證，不可直接套用舊決策。

玩家用windowToken驗證是否仍屬同一行動窗口；不要把truth stream全域sequence當成玩家必須提供的公開revision，避免洩漏隱藏活動數量。

預設沒有自動逾時：等候輸入。將來NPC API失敗由協調層處理，不能偽造神職已操作；系統可暫停，不得讓引擎替玩家猜技能。

## 7. 事件封套與觀察契約

### 7.1 EventEnvelope

eventId、gameId、sequence(從1連續遞增)、eventType、eventVersion、transactionId、causationCommandId、causedByEventIds[]、phaseId(可null)、recordedAtIso、audience、payload。

Audience是以下union之一：
- { kind: SYSTEM_TRUTH }
- { kind: PUBLIC }
- { kind: PRIVATE_RECIPIENTS, playerIds: [...] }

PRIVATE_RECIPIENTS收件人於發布時固定，不在讀取時依現在陣營／現在角色重新求值。類似PRIVATE_FACTION只能用於內部尋址，落地前必須展開收件人。

Raw EventEnvelope整體仍是受保護資料。B會生成新的玩家Observation資料，不直接JSON.stringify原事件，也不揭露隱藏事件sequence缺口、actor、cause、除錯reason或處理時間。

### 7.2 發生與交付分開

SeerCheckResolved(SYSTEM_TRUTH)保存真實查驗計算。
PrivateObservationPublished(PRIVATE_RECIPIENTS)保存交給本人的查驗結果。
DawnAnnouncementPublished(PUBLIC)只保存按座號排序的死亡名單／平安夜，不保存夜間死因。
SpeechPublished(PUBLIC)只代表說話事件，不是內容被認證。
WolfMessagePublished(PRIVATE_RECIPIENTS)只交給發布時有資格的活狼。

觀察事件本身也可列在同一受保護事件流中；但玩家只能經B的專屬輸出取得。PUBLIC標籤不是允許把整個truth stream給前端。

## 8. 事件目錄與唯一責任

A-01只實作標為「A-01」的四種事件；其餘是後續規格，不做空殼handler。

| 事件 | 責任 | 阶段 |
|---|---|---|
| GameCreated | 建立LOBBY、初始ruleset draft | A-01 |
| SeatsConfigured | 完整替換LOBBY座位配置 | A-01 |
| SetupLocked | 一次原子寫入manifest與role assignments，進LOCKED | A-01 |
| GameAborted | 標記中止、保留歷史，不產生勝方 | A-01 |
| GameStarted | 初始化runtime與第一夜 | 後續 |
| PhaseOpened / PhaseClosed | 狀態機轉移 | 後續 |
| ActionWindowOpened / ActionWindowClosed | 固定行動資格與窗口 | 後續 |
| WolfMessagePublished | 記錄已發出的隊內訊息 | 後續 |
| WolfBallotCommitted / WolfTargetCommitted | 刀票與最終團隊刀口 | 後續 |
| NightActionCommitted | 角色的已鎖定意圖，payload是有類型union | 後續 |
| AbilityResourceSpent | 記錄合法資源消耗 | 後續 |
| StatusApplied / StatusExpired | 套用／失效狀態 | 後續 |
| SeerCheckResolved | 記錄真實查驗結果 | 後續 |
| EffectResolved | 有類型的防護／傷害效果結果 | 後續 |
| DeathWaveResolved | 同波所有死亡與完整原因，一次更新生命狀態 | 後續 |
| ReactionWindowOpened / ReactionCommitted / ReactionClosed | 獵人等反應 | 後續 |
| ResolutionGroupSettled | 完整死亡連鎖與反應結束 | 後續 |
| PrivateObservationPublished | 固定收件人的合法資訊 | 後續 |
| DawnAnnouncementPublished | 公開總死訊 | 後續 |
| SpeechPublished / SpeechFinished | 保存發言原文與進度 | 後續 |
| SheriffSignupCommitted / SheriffWithdrawalCommitted | 上警及退水 | 後續 |
| VoteSessionOpened / BallotCommitted / VoteSessionResolved | 投票名單、每票、計算结果 | 後續 |
| SheriffElected / SheriffTransferred / SheriffBadgeDestroyed | 警徽更新 | 後續 |
| SelfExplosionCommitted | 公開確認自爆並觸發結算，不直接重複扣生命 | 後續 |
| GameEnded | 保存勝方／平局與判定依據 | 後續 |
| PostGameRevealPublished | 終局資料展示 | 後續 |

刻意取代舊草案的RolesAssigned + GameLocked多步驟：使用SetupLocked一次鎖定，避免只寫入一半。死亡唯一改生命狀態的事件是DeathWaveResolved，不再讓PlayerExecuted、PlayerDied、SelfExploded各扣一次生命。

未知事件或版本：拒絕載入／明確報錯，不以default分支悄悄略過。將來版本轉換使用經測試的讀取轉換，不改舊檔。

## 9. 夜間資訊與結算順序

夜間流程是由依賴關係決定，不靠NPC記得順序。

1. 建立nightStartSnapshot；確定誰當夜有行動資格。
2. 守衛窗口提交守護或空守；不讓他看到本夜狼刀。
3. 狼隊私聊、提交刀票、鎖定最終刀口。
4. 狼美人提交新魅惑或保留。
5. 女巫資訊窗口依knifeInfoMode發布刀口／NO_ATTACK／UNAVAILABLE，再提交一個完整用藥決策。
6. 預言家提交查驗；完成查驗並私密交付結果。
7. 等所有必要窗口完成；套用本夜守護與新魅惑。
8. 同時計算狼刀、解藥、毒、保護碰撞，建立第一個死亡波。
9. 必然殉情閉包計算完成，寫入DeathWaveResolved。
10. 公布DawnAnnouncement，只列死者。
11. 執行合法且尚未處理的死亡技能，必要時建立下一死亡波。
12. ResolutionGroupSettled後檢查勝負。
13. 未結束才處理遺言與警徽，再進第一日競選或一般白天。

夜初活著的人不會因同夜稍後死亡而失去已提交行動。以上邏輯窗口是內部順序，不表示共用畫面應公開「現在輪到真正的女巫」。實體隱私流程留給B/UI。

## 10. 死亡波與完整結算群組

ResolutionGroup：一次夜晚、放逐、自爆或主動技能及其所有連鎖。
DeathWave：同一批共同決定的死亡。

同波處理：以波開始時存活集合與所有直接效果計算，找出必然死亡，再把因死亡觸發的魅惑加入，直到不再增加效果。最後建立每位死者的完整causes集合；同人只死一次。

同波中狼人刀與毒命中同一獵人，原因集合含毒，禁止槍。狼美人與被魅惑獵人同波一起死，魅惑仍計入該波死因集合，禁止槍。

若魅惑目標在更早波已死亡，不新增死因、不撤銷已完成的技能。獵人射死狼美人，狼美人魅惑的正是已死且已開槍獵人時，不倒帶取消該槍。

每個被動觸發用(effectId, triggerDeathId)去重；循環連結不無限執行。所有可改世界的必然效果先處理完，才發出選擇性死亡技能token。

等待獵人選擇時必須保存pendingReaction及continuation。應用重啟不重複給第二槍、不丟失未完成槍。

夜間死訊需先公開才能要求玩家白天開槍；因此群組可以跨Dawn發布，尚未settled不代表未能發布任何合法觀察。未settled期間不得開始普通發言、投票或下一夜。

## 11. 自爆時的競態與流程

自爆與一般發言可能同時到達。Repository先成功append的交易有效。自爆一旦成功，其他舊windowToken的命令拒絕。已正式發布的發言保留，不刪歷史；尚未發布的NPC草稿丟棄。

SelfExplosionCommitted → 第一波含自爆者 → 必然魅惑／死亡技能 → ResolutionGroupSettled → 勝負判定 → 未終局的警徽操作 → 下一夜。

「立即入夜」表示中止一般白天流程，不表示跳過規則連鎖。

## 12. 儲存、重播、恢復

一局遊戲是一條有序事件流；v1採單程序、單遊戲寫入序列，仍用expectedSequence防止重複或競爭寫入。不建Kafka、微服務、分散式event bus。

保存單位是一個交易：events[] + 成功commandReceipt，全部成功或全部失敗。不可只寫入扣藥而漏掉行動，不可只寫死狼美人而漏掉群組狀態。

CommandReceipt：commandId、gameId、principalKey、canonicalRequest、firstSequence、lastSequence、outcomeCode。Canonical request比較所有有意義欄位，不依物件key插入順序；相同ID不同內容拒絕。

A-01使用記憶體repository，支援JSON匯出／匯入到新的repository；這只驗證資料可恢复，不表示已完成當機自動存檔。後續才加有交易能力的本機持久化adapter。

ExportBundle：formatVersion、gameId、events、commandReceipts。這是truth備份，不得作為一般觀戰下載。匯入須驗證schema、gameId一致、sequence連續、eventId唯一、receipt範圍正確、狀態轉移合法。先完整驗證與重播到暫存資料，成功後一次替換，失敗不能污染現有資料。

Snapshot只能在一致狀態點建立，保存sequence、schema/engine版本與state。缺失或損壞時丟棄並重播。A-01不需實作snapshot最佳化。

完整事件重播不重抽身份、不重跑AI、不用新版技能規則改算歷史。要繼續一場舊局，則必須具有相容的engine與handler版本；不相容時只允許歷史展示或明確拒絕續局。

## 13. 隨機性與資料安全界線

正式抽牌使用可信隨機來源，经依賴注入傳入application service；測試可注入可重現來源。分配以固定角色multiset進行shuffle，結果只保存一次。不能為了劇情、玩家好玩或讓NPC獲勝重抽。

抽牌、公開順序及未來NPC隨機性使用不同來源／不同域，不能藉公開seed還原角色。Replay依已记录結果，無需暴露seed。

不可變性靠型別、runtime schema驗證、不暴露可寫參考、deep clone/freeze、command白名單與唯一寫入通道共同維持。TypeScript readonly本身不是runtime安全機制。

本機同裝置產品先採「信任裝置持有人」的桌遊威脅模型。有人能控制程式、修改本機儲存或開發工具，不在A-01防作弊保證內。共用螢幕遮罩也不能防止玩家直接偷看螢幕或偷聽；後續需專門設計傳機／私密裝置流程。

## 14. 全A層測試矩陣

| 測試ID | 情境 | 必須結果 |
|---|---|---|
| A-ID-01 | 12角色配置與座位 | 次數、ID與總數正確 |
| A-ID-02 | 鎖牌後重抽／改角色 | 拒絕，原配置不變 |
| A-ID-03 | 外部改輸入物件／讀出結果 | 不污染內部state |
| A-ID-04 | 未知角色或規則欄位 | 拒絕，不猜測 |
| A-LOG-01 | 完整replay | 與原state相等 |
| A-LOG-02 | 同commandId重送 | 原receipt，不重抽不重扣 |
| A-LOG-03 | 同ID不同payload | 明確拒絕 |
| A-LOG-04 | sequence缺口／重复／未知事件 | 匯入拒絕 |
| A-LOG-05 | 並行不同命令同revision | 最多一筆成功append |
| A-LOG-06 | batch中任一項驗證失敗 | 全部不写入 |
| A-N-01 | 狼刀／守中／救中 | 符合結果表 |
| A-N-02 | 同守同救 | 按鎖定規則結算 |
| A-N-03 | 女巫N2吃刀仍毒人 | 毒生效，不可自救 |
| A-N-04 | 女巫雙藥請求 | 拒絕 |
| A-N-05 | 用完解藥下夜 | 預設UNAVAILABLE，不發刀口 |
| A-N-06 | 守A／空守／守A | 合法 |
| A-N-07 | 連續守A | 預設拒絕 |
| A-N-08 | 新魅惑+同夜死亡 | 新目標殉情、舊目標解除 |
| A-N-09 | 魅惑先死的玩家 | 不重複死亡 |
| A-N-10 | 狼隊刀票平票 | NO_KILL |
| A-D-01 | 獵人毒刀同中 | 一死、不能開槍 |
| A-D-02 | 狼美人與被魅惑獵人同波死 | 禁槍 |
| A-D-03 | 獵人開槍帶走狼美人 | 新死亡波正常連動 |
| A-D-04 | 最後狼與最後神同群組死 | DRAW |
| A-D-05 | pending槍期間恢复 | 不跳過、不重給 |
| A-V-01 | 退水 | 無警長選票 |
| A-V-02 | 警長放逐票 | 3 units，其餘2 |
| A-V-03 | 選舉票 | 全部2 units |
| A-V-04 | PK、全棄、無候選、單候選 | 按明文規則 |
| A-V-05 | 未齊票 | 不公布部分票型 |
| A-S-01 | 發言自稱女巫 | 只記speech，不改身份 |
| A-S-02 | 自爆與發言並行 | 交易順序決定，舊窗口拒絕 |
| A-S-03 | 自爆+殉情 | 先結算、後勝負、再入夜 |
| A-P-01 | 普通夜間雙死 | 公開只含死亡名單，不洩漏刀毒原因 |
| A-P-02 | 狼隊訊息 | 固定存活收件人，死狼無新訊息 |

資訊不可區分世界測試與NPC prompt泄漏測試由B/C補齊；上表部分P類需要B整合後才能完整驗收，不得A單獨宣稱全面防天眼。

## 15. 實作里程碑與完成邊界

A-01：專案骨架、runtime schemas、建局、座位配置、鎖牌、四種事件、純reducer、記憶體store、原子append、重送處理、JSON重播測試。停在LOCKED。
A-02：規則registry、phase/session、基礎夜間意圖與資源。無NPC。
A-03：夜間結算、死亡波、魅惑、獵人、勝負checkpoint。
A-04：警長、發言、投票、PK、自爆、遺言與完整流程。
A-05：持久化、恢复、snapshot、版本兼容、全局回歸測試。
B：Player View與各座位私密資訊、介面觀察契約。
C：NPC認知／記憶／決策，分開的上下文與證據紀錄。
整合：真人/NPC混合、文字輸入、共用裝置隱私，再考慮語音和更多板子。

A-01驗收通過不代表可以玩一局。完整A驗收通過也不代表NPC已獨立思考。每個階段要按照測試與範圍真實標示進度。

## 16. 給後续prompt的固定契約

每份prompt必须包含：本次milestone、前置檔案、唯一權威規格、精確範圍、禁止項目、資料契約、需新增測試、必跑指令、交付物、停止點。

實作者不能只說「完成」；必須提供改動檔案、核心diff、實際命令結果、未完成項目。未執行測試就標記未執行，不能寫PASS。

不得用@ts-ignore、核心any、删除測試、測試只驗證mock自己、硬編碼固定角色表，來滿足驗收。

## 17. 官方技術參考

本文件的狼人殺房規是產品決策，以下資料只支援工程做法，不為房規背書。核對日期2026-09-19。

[S1] Microsoft Learn，Event Sourcing pattern：事件歷史、重播、樂觀並行、版本與快取的取捨。
`https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing`

[S2] TypeScript Handbook，Object Types：readonly不改變runtime行為。
`https://www.typescriptlang.org/docs/handbook/2/objects.html`

[S3] Zod，Defining schemas：runtime schema與strict object驗證。
`https://zod.dev/api`

[S4] Node.js Releases：使用仍受支援LTS作為執行環境；目前以24.x為基線，實作時核對相依套件。
`https://nodejs.org/en/about/previous-releases`

[S5] Vitest Getting Started：測試runner安裝與環境需求，實作時鎖定確切相容版本。
`https://vitest.dev/guide/`
