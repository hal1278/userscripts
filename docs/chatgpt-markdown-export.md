# ChatGPT Markdown Handoff 仕様

対象: [`scripts/chatgpt-markdown-export.user.js`](../scripts/chatgpt-markdown-export.user.js)

画面に表示されている一本道の ChatGPT の会話を、Claude などに引き継ぐために Markdown でクリップボードに
コピーする。Firefox + Violentmonkey で使う。

未確認の点は 5 節にまとめる。それ以外の項目は実装済み。

## 1. 設計方針

- ChatGPT の API や本文の表現は頻繁に変わる。非公式な構造への依存は最小限にし、想定外の形は
  できる範囲で無視または素通しして、出力を続ける（best effort）。
- 出力はユーザーが毎回確認する。厳密さより、実装の簡潔さを優先する。
- エラーで止めるのは、続けても意味のある出力にならない場合だけ:
  会話 ID が取れない、取得に失敗した、一本道を作れない（`mapping` や `current_node` が無い、循環）、
  出力するメッセージが 1 件も無い。
- clean-room で実装する（既存の userscript を参照しない）。外部依存なし。ChatGPT の DOM に依存しない。

## 2. 起動と取得

- Violentmonkey のメニュー「Copy conversation as Markdown」から実行する。
- 会話 ID は `location.pathname` 中の `/c/<uuid>` から取る（Project 内の `/g/g-p-…/c/<uuid>` も可）。
- `GET /api/auth/session` の `accessToken` を使い、`GET /backend-api/conversation/<id>` を取得する。
  fetch には `cache: "no-store"` を付ける。
- 失敗時は、段階（session / conversation）と HTTP status を通知する。token は出力しない。
- 結果を `GM_setClipboard` でコピーし、`GM_notification` で通知する。

## 3. 抽出

- `current_node` から `parent` をたどってルートまで遡り、反転する。`parent` が無い node はルートとみなす。
- 出力するのは次のメッセージだけ。
  - user で、`content_type` が `text` / `multimodal_text`
  - assistant で、`channel` が無いか `"final"`、`content_type` が `text` / `multimodal_text`
- `metadata.is_visually_hidden_from_conversation === true` は除外する。画面に出ないメッセージで、
  直前の回答と同じ本文を持つ例があった。
- `parts` の文字列は `\n\n` で連結し、文字列以外は `*[attachment]*` にする。

## 4. 出力

```
---
title: "<title>"
conversation_id: <id>
created: <ISO8601>
exported: <ISO8601>
url: https://chatgpt.com/c/<id>
---

## User

...

## ChatGPT (<model_slug>)

...
```

- title は YAML の二重引用符形式でエスケープする。
- 欠けている値の扱い: title が無ければ `""`、`create_time` が無ければ `created` 行を
  省く、`model_slug` が無ければ見出しを `## ChatGPT` にする。
- 本文は API が返すものをそのまま使う。ChatGPT 独自のタグ（`<box>`、`<form>`、`<svg>`、`<text>`、
  `<caption>` など）も変換しない。例外は次の 2 つだけ。
- 図（ウィジェット内のインライン SVG）も、ソースのテキストのまま本文に残る。Markdown ビューアでは
  図として表示されないが、Claude はラベルや構造を読める。画像ファイルの保存や、Markdown と別の
  コピーはしない。添付画像は `*[attachment]*` になり、画像データは含めない。

### 4.1 引用

- `<Cite …/>` タグ中の引用符で囲まれた文字列をすべて ref とみなす（`<Cite ref="a"/>` と
  `<Cite refs={["a","b"]}/>` の両方の形式があった）。
- 出典が分かる ref は `[<title>](<url>)`、分からない ref は名前のまま、`; ` で区切って `( … )` で囲む。
  1 つも分からなければタグをそのまま残す。
- 出典は、会話 JSON 全体を再帰的に探し、文字列の `ref_id` と `url` を持つオブジェクトから作る
  （`title` が無ければ url を表示する）。格納場所のパスには依存しない。
- 2026-11-07 時点の実例では、出典は assistant メッセージの UI 用メタデータ（`model_dil_v2` の下）に
  あり、別のメッセージにある ref を参照することもあった。

### 4.2 フォームへの回答

- ChatGPT のフォームで送信した回答は、通常の user メッセージとして保存される。
- 直前の assistant メッセージの本文（コードブロックを除く）に `<form` があれば、見出しを
  `## User (form response)` にする。

## 5. 未確認の点

- Firefox / Violentmonkey の sandbox で、fetch に session cookie が付くか。付かなければ
  `GM_xmlhttpRequest` + `@connect chatgpt.com` に切り替える。なお chatgpt.com の `window.fetch` は
  計測用と思われるラッパーに置き換えられており、page context で動く場合はそれを経由する。
- 回答の生成中に実行した場合、生成途中の回答が出力されうる。
- 画面で分岐を切り替えたとき、サーバー側の `current_node` も切り替わるか。
- 画面の表示不具合（切り替え直後の部分読み込み、送信後に前の回答が消える）の間の API 応答。
  切り替え前後・URL を開き直した後・F5 後の 4 条件では応答が一致し、HTTP キャッシュや Service Worker
  も関与していなかったが、症状そのものは再現できていない（2026-11-07、Chromium 系ブラウザ）。

## 6. テスト

- `node:test` で、合成 fixture（`tests/fixtures/`）を使って純粋関数をテストする。実際の会話データは
  置かない。fetch とクリップボードは対象外。
- `biome check` を通す。
