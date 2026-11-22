# Gemini Markdown Handoff 仕様

対象: [`scripts/gemini-markdown-export.user.js`](../scripts/gemini-markdown-export.user.js)

画面に表示されている Gemini の会話を、Claude などに引き継ぐために Markdown でクリップボードに
コピーする。Firefox + Violentmonkey で使う。ChatGPT 版（[chatgpt-markdown-export.md](chatgpt-markdown-export.md)）
とは別のスクリプトにする。共通部分（YAML のエスケープなど）はコピーし、`@require` で共有はしない。

2 節以降の API の形は、2026-11-22 に Chromium 系ブラウザ（Claude のブラウザペイン、ログイン済み）
で、5 往復・分岐なし・添付なしの実際の会話 1 件を開き、ページ上から同じ RPC を送って確かめた。
未確認の点は 6 節にまとめる。それ以外の項目は実装済み。

## 1. 設計方針

- ChatGPT 版と同じく best effort。想定外の形はできる範囲で無視して出力を続ける。
- Gemini にはキー付き JSON の API が無く、内部 RPC（`batchexecute`）の応答はキーの無い入れ子配列
  になっている。位置（何番目か）で読むしかないので、次の 2 つで壊れにくくする。
  - 位置で読むのは 3 節の浅い場所だけにする。
  - ID の形（`r_…`、`rc_…`）や値の型を確かめて、合わなければその要素を飛ばす。
- エラーで止めるのは次の場合だけ: 会話 ID が取れない、トークンが取れない、取得に失敗した、
  出力するメッセージが 1 件も無い。
- clean-room。外部依存なし。DOM には依存しない。例外として、タイトルだけは `document.title` から
  取る（4 節）。

## 2. 起動と取得

- Violentmonkey のメニュー「Copy conversation as Markdown」から実行する。
- 会話 ID は `location.pathname` の `/app/<16 桁の hex>` から取り、`c_<hex>` にする。
- ページの `WIZ_global_data` から次の 3 つを取る（sandbox からは `unsafeWindow` 経由）。
  - `SNlM0e`: リクエスト本文の `at`
  - `cfb2h`: クエリの `bl`
  - `FdrFJe`: クエリの `f.sid`
- `POST /_/BardChatUi/data/batchexecute?rpcids=hNvQHb&source-path=<pathname>&bl=…&f.sid=…&hl=<lang>&_reqid=<数字>&rt=c`
  - 本文（form-urlencoded）は次の 2 つ。
    - `f.req=[[["hNvQHb", "<引数の JSON 文字列>", null, "generic"]]]`
    - `at=<SNlM0e>`
  - 引数は `["c_<id>", <件数>, <続きトークン or null>, 1, [1], [4], null, 1]`。Web アプリが送る形を
    そのまま使う。
- 応答の先頭は `)]}'`。そのあとに長さ行と JSON 行が交互に続く。`["wrb.fr", "hNvQHb", "<JSON 文字列>"]`
  の 3 番目を JSON として読む。
- 読んだ値は `[往復の配列, 続きトークン, …]`。続きトークンが文字列のあいだは、それを引数に入れて
  繰り返し取得する。件数 2 で 3 回取得した結果は、件数 10 で 1 回取得した結果と一致した。
  実装では件数 10 で取得し、トークンが空・同じトークンの再出現・200 回で止める。
- リクエストはページの `fetch`（sandbox からは `unsafeWindow.fetch`、引数は `cloneInto` でページへ
  複製）で送る。Firefox + Violentmonkey で sandbox 自身の `fetch` を使ったところ、
  `NetworkError when attempting to fetch resource.` で失敗した（2026-11-22、ユーザー報告）。
- 失敗時は、段階（token / history）と HTTP status を通知する。トークンは出力しない。

## 3. 抽出

往復の配列は新しい順なので、反転して古い順にする。1 往復 `t` から読むのは次の場所だけ。

| 値                       | 場所         | 確認                                         |
| ------------------------ | ------------ | -------------------------------------------- |
| ユーザー発言             | `t[2][0][0]` | 文字列でなければその往復のユーザー側を飛ばす |
| 回答の候補（下書き）一覧 | `t[3][0]`    | 配列                                         |
| 選ばれた候補の ID        | `t[3][3]`    | `rc_` で始まる文字列だった                   |
| モデル名                 | `t[3][21]`   | 文字列のときだけ使う                         |
| 時刻                     | `t[4]`       | `[秒, ナノ秒]`                               |

- 回答は、候補一覧の中から `[0]` が選ばれた候補の ID と一致するものを探す。見つからなければ
  先頭の候補を使う。本文は `候補[1]` の最初の文字列で、Markdown になっている。
- 思考過程（`候補[37]` にあった）は出力しない。位置を決め打ちせず、本文以外は読まないことで除く。
- 出典は `候補[2]` にあった。本文の文字位置の範囲と URL の組 `[開始, 終了, [url, …]]` の並びで、
  本文には印が無い（画面ではチップとして出る）。5 節の方針にする。

## 4. 出力

````
---
title: "<title>"
conversation_id: c_<id>
created: <最初の往復の時刻, ISO8601>
exported: <ISO8601>
url: https://gemini.google.com/app/<id>
---

## User

```markdown
...
```

## Gemini (<model>)

```markdown
...
```
````

- title は会話の RPC 応答に含まれていなかった。`document.title` の末尾の ` - Google Gemini` を
  除いて使う。取れなければ `""`。
- 欠けている値の扱いは ChatGPT 版と同じ。時刻が無ければ `created` 行を省き、モデル名が無ければ
  見出しを `## Gemini` にする。
- 本文は API が返すものをそのまま使う。Gemini 独自のタグ（例: 回答末尾の
  `<FollowUp label="…" query="…"/>`、次の質問の候補）も変換しない。

### 4.1 本文の囲み

回答の本文は `## …` の見出しをよく使い、区切りの `## User` / `## Gemini` と同じ階層になる
（2026-11-22 の 7 往復の会話で、本文中の `## ` の見出しが 18 個あり、うち 3 個はユーザー発言の
中だった）。区切りをはっきりさせるため、User と Gemini の本文をコードブロックで囲む。

`````
## User

```markdown
<ユーザー発言>
```

## Gemini (<model>)

````markdown
<回答。中に ```c … ``` などがあってもよい>
````

Sources:
- <url>
`````

- 囲みのバッククォートの数は、本文中で最も長いバッククォートの連続より 1 つ多くし、最低 3 つにする。
  本文のコードブロック（ふつうは 3 つ）が囲みを閉じてしまわないようにするため。
- 情報文字列は `markdown` にする。
- 本文は変更しない（見出しの階層を下げるなどはしない）。末尾の改行だけは除く。
- `Sources:` はスクリプトが付けるものなので、囲みの外に置く。
- 影響: Markdown ビューアでは、本文の表や太字などが描画されず、ソースのまま表示される。
  Claude が読む分には変わらない。
- ChatGPT 版も同じ規則にしている（[chatgpt-markdown-export.md](chatgpt-markdown-export.md) 4.3 節）。

## 5. 出典

- 回答ごとに、`候補[2]` の中の URL を重複なしで集め、本文の末尾に次の形で付ける。

  ```
  Sources:
  - <url>
  ```
- 範囲の数字は使わない（本文に印を差し込む位置が正しいか、確かめていないため）。
- 探し方は ChatGPT 版と同じく位置に依存しない。`候補[2]` の中を再帰的にたどり、
  `[数値, 数値, [文字列, …]]` の形の配列から、`http(s)://` で始まる最初の文字列を URL とする。
  同じ配列にはファビコン（`gstatic.com`）の URL もあったが、最初の文字列ではないので拾わない。
- 出典のタイトルは見つけていないので、URL だけを出す。

## 6. 未確認の点

- Firefox + Violentmonkey で、ページの `fetch` 経由なら取得できるか（0.1.1 で変更、未確認）。
  `unsafeWindow.WIZ_global_data` は読めている（0.1.0 の失敗は history の段階だった）。
  2026-11-22 に、スクリプト全体を page context で実行した（GM_* は stub、Chromium 系ブラウザ、
  7 往復の会話）。その条件では取得からコピーまで通り、往復数は画面と一致した。
- 下書き（候補が複数ある回答）、発言の編集、再生成のときの構造。今回の会話はどれも候補 1 件だった。
- 画像やファイルを添付したユーザー発言、画像を生成した回答、Canvas、Deep Research の形。
- Gem や共有リンク（`/share/…`）の URL 形式。
- 出典の文字位置が UTF-16 単位か、どの文字列に対する位置か。
- 回答の生成中に実行した場合の挙動。

## 7. テスト

- ChatGPT 版と同じく、合成 fixture で純粋関数（応答の分解、往復の抽出、出典、Markdown 組み立て）
  をテストする。fixture は上の位置に合わせて手で作り、実際の会話データは置かない。
