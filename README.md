# Lancers 名鑑 — スクレイピング & 検索サイト

English guide: [README_EN.md](README_EN.md)

## 構成
```
scraper/lancers_scraper.py   収集スクリプト（プロキシ経由・再開可能）
scraper/proxy.txt            プロキシ設定（git 管理外。proxy.example.txt をコピーして作成）
scraper/vendor/              beautifulsoup4 / soupsieve（pip 不要で同梱）
data/lancers_profiles.csv    出力 CSV（= サイトのデータベース）
data/lancers_profiles.json   同内容の JSON
data/_state/                 チェックポイント（profile_links.json, profiles.jsonl, ログ）
web/                         検索サイト（静的 HTML/CSS/JS、ビルド不要）
serve.py                     ローカルサーバー
```

## 収集（スクレイピング）
```bash
cd scraper
LANCERS_WORKERS=3 python3 lancers_scraper.py      # 全ページ → 全プロフィール → CSV 出力
python3 lancers_scraper.py --export-only           # チェックポイントから CSV を再出力
```
- 通信はすべて `scraper/proxy.txt` のプロキシ経由（環境変数 `LANCERS_PROXY` で上書き可）。ホストの IP は使いません。
- プロキシが一時的に接続を拒否することがあるため、数秒おきに再試行します。
- Lancers が CAPTCHA（AWS WAF）を返した場合は全リクエストを 10〜30 分停止し、その後自動で再開します。リクエスト間隔は既定で 4 秒（環境変数 `LANCERS_INTERVAL` で変更可）です。
- 途中で止めても再実行すれば続きから再開します（`data/_state/`）。
- 失敗したプロフィールは `data/_state/failed.json` に記録され、再実行で再取得されます。

### CSV の列
| 列 | 内容 |
|---|---|
| username / display_name | ユーザー名 / 表示名 |
| profile_url / avatar_url | プロフィール URL / アバター画像 URL |
| rank / rank_code | 認定ランサー・認証ランサー・シルバー・ブロンズ・レギュラー |
| entity_type | 法人 / 個人 |
| job_category / prefecture | 職種 / 都道府県 |
| orders / tasks | 実績数（受注数）/ タスク数 |
| good_reviews / bad_reviews | 良い評価 / 悪い評価 |
| completion_rate / task_approval_rate / repeaters / external_achievements | 完了率 / タスク承認率 / リピーター / 外部実績 |
| last_login_text / last_login_minutes | 最終ログイン（表示文字列 / 分換算） |
| availability | 稼働状況 |
| registered_date / registered_days_ago | 登録日 / 登録からの日数 |
| identity_verified / nda_verified / phone_verified / lancers_check | 本人確認 / 機密保持確認 / 電話確認 / ランサーズチェック（1=済） |
| invoice_ready / video_meeting / beginner_friendly | 適格請求書 / ビデオ面談 / 初心者にやさしい |
| badges | その他バッジ（Lancer of the Year など、`|` 区切り） |
| categories / categories_proven | 得意なカテゴリ / うち実績あり（`|` 区切り） |
| industries / industries_proven / skills | 得意な業種 / うち実績あり / スキル |
| hourly_rate / reply_rate_24h / catchphrase / scraped_at | 稼働単価 / 24h 返信率 / キャッチコピー / 取得日時 |

## サイト
```bash
python3 serve.py          # http://localhost:8000/ が開きます
```
- 検索: スペース区切り AND、`OR`、`-除外`、`"フレーズ"`、検索対象の切り替え
- 絞り込み（すべて同時適用）: ✔マーク、ランク、法人/個人、登録日（プリセット・日数・期間）、最終ログイン、稼働状況、職種、都道府県、カテゴリ/業種/スキル（いずれか・すべて・実績ありのみ）、受注数・評価・完了率などの数値範囲、認証、バッジ
- 例:「登録から30日未満 × 認定ランサー × 法人」= 登録日「30日未満」+ ランク「認定ランサー」+「法人」
- カードをクリックするとモーダルで全情報を表示。モーダル内の 2 つのラジオボタンで ✔ マークを付け外しでき、状態は localStorage に保存されるため再読み込みしても保持されます。
- 「検索リンクをコピー」で現在の条件を URL として共有、「CSV書き出し」で結果を保存できます。
- 静的サイトなので `web/` と `data/lancers_profiles.csv` をそのまま Vercel / Netlify 等に配置しても動作します（`web/data/` に CSV をコピーしてください）。
