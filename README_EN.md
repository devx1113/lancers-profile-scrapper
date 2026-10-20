# Lancers Directory — Usage Guide

Collects public Lancers profiles into a CSV file, then lets you search them in a local website.

**Requirements:** Python 3. Nothing else to install.

---

## 1. Collect the data

```bash
cd scraper
python3 lancers_scraper.py
```

- All traffic goes through the proxy in `scraper/proxy.txt`. Your own IP is never used.
  First time only: copy `proxy.example.txt` to `proxy.txt` and put your proxy in it.
- It takes many hours. You can stop it at any time (Ctrl+C) and run the same command again to continue.
- The CSV is updated every 250 profiles, so you can open the website before it finishes.

If Lancers shows a CAPTCHA, the scraper pauses by itself (10–30 min) and tries again.
If it stays blocked for hours, use a different proxy:

```bash
LANCERS_PROXY="http://user:pass@host:port" python3 lancers_scraper.py
```

To rebuild the CSV from what was already collected, without downloading anything:

```bash
python3 lancers_scraper.py --export-only
```

## 2. Open the website

```bash
python3 serve.py
```

Your browser opens at **http://localhost:8000/**.

## 3. Use the website

**Search box**

| Type | Finds |
|---|---|
| `SEO ads` | profiles containing both words |
| `React OR Vue` | profiles containing either word |
| `-副業` | profiles **without** that word |
| `"Web広告"` | that exact phrase |

Use the buttons under the box to search only names, skills, categories, etc.

**Filters (left side)**
Every filter you pick is combined. For example, to find corporate, 認定 (authorized) lancers who registered less than 30 days ago:
1. 登録日 (registration date) → **30日未満**
2. ランク (rank) → **認定ランサー**
3. 法人 / 個人 (corporate or individual) → **法人**

You can also filter by last login, availability, job, prefecture, category, industry, skill, badges, verifications, and number ranges such as orders, good reviews, bad reviews and completion rate.
For categories, industries and skills, choose **いずれか** (any) or **すべて** (all).

**Profile details**
Click any card to open a window with all of that user's information and a link to their Lancers page.

**✔ mark**
In the profile window, choose **✔ マークを付ける** to add the mark, or **マークを外す** to remove it.
The mark is saved in your browser and stays after reloading. Use the **✔マーク** filter to show only marked users.

**Other buttons**
- **検索リンクをコピー** copies a link that reopens the same search.
- **CSV書き出し** downloads the current results as a CSV.
- **すべて解除** clears every filter.

---

## Files

| Path | What it is |
|---|---|
| `data/lancers_profiles.csv` | The collected data (the website's database) |
| `scraper/lancers_scraper.py` | The scraper |
| `scraper/proxy.txt` | Your proxy (not stored in git) |
| `web/` | The website |
| `data/_state/` | Saved progress and logs. Delete it to start over from zero. |

Column descriptions are in [README.md](README.md).
