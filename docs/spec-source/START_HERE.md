# 這一包怎麼用

這是設計與實作指令，不是App程式碼。包內只有Markdown與純文字。

## 檔案

A_CORE_SPEC_v1.0.md：整合A、A-2、A-3的規則核心基準，涵蓋完整A層。供coding AI理解全貌。
PROMPT_01_A_FOUNDATION.txt：第一個可執行任務。只做A-01，到建局／鎖牌／事件重播為止。
START_HERE.md：本操作說明。

## 交給coding AI的操作

先在coding工具打開一個專案工作區。空專案可以；已有專案也可以，但不要要求它刪除重建。

將A_CORE_SPEC_v1.0.md加入工作區docs/，或以附件上傳給coding AI。

開啟PROMPT_01_A_FOUNDATION.txt，完整複製內容，貼到coding AI的實作對話並送出。不要只貼本操作說明，也不要把整份A規格當成「一次做完」的任務。

若工具不能上傳檔案，先貼A_CORE_SPEC內容並附註「這是規格背景，尚不要實作；實作範圍以下一則A-01指令為準」，再貼完整PROMPT_01內容。

只有第一份prompt可以執行。完成後不讓它自行進入下一階段。

## 完成後帶回來供檢查

需要docs/A01-report.md、修改檔案列表、typecheck/test/build實際輸出。摘要只能用於初步檢查；要做真正程式碼審查，還需要schemas、reducer、command handler、repository、tests的實際內容或完整diff。

可以上傳原始碼zip，排除node_modules、編譯產物、API keys、.env和其他秘密。

不要把coding AI自己寫的「全部通過」當成唯一驗收依據。報告必須列出命令與實際結果；無法執行時標示未執行。

## 本次預期結果

有一份可以用測試驗證「12身份鎖定、不能偷偷重抽、事件可重播、重送不重複」的核心程式。

沒有可玩的介面是正常的；這次本來就不做。技能、完整流程、私密Player View和NPC仍在後續里程碑。
