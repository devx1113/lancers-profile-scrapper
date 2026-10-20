#!/usr/bin/env python3
"""
Lancers profile scraper.

Phase 1: walk https://www.lancers.jp/profile/search?... page by page until the
         last page, collecting every href of
         <a class="p-search-talent__media-description-text">.
Phase 2: open each profile and extract the fields listed in FIELDS.
Output : data/lancers_profiles.csv (+ data/lancers_profiles.json)

All HTTP traffic goes through the proxy in scraper/proxy.txt or $LANCERS_PROXY (never the host IP).
Progress is checkpointed in data/_state/ so the script can be re-run and resume.
"""
import csv, gzip, json, os, random, re, sys, time, threading
import urllib.request, urllib.error, urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor"))
from bs4 import BeautifulSoup  # vendored pure-python package

# ---------------------------------------------------------------- config ----
def _load_proxy():
    """Proxy URL from $LANCERS_PROXY, else the first line of scraper/proxy.txt (kept out of git).
    Accepts http://user:pass@host:port or the provider's host:port:user:pass format."""
    value = os.environ.get("LANCERS_PROXY", "").strip()
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "proxy.txt")
    if not value and os.path.exists(path):
        lines = [l.strip() for l in open(path, encoding="utf-8")]
        value = next((l for l in lines if l and not l.startswith("#")), "")
    if not value:
        sys.exit("No proxy configured: copy scraper/proxy.example.txt to scraper/proxy.txt "
                 "and fill it in, or set LANCERS_PROXY.")
    if "://" not in value:
        parts = value.split(":")
        if len(parts) == 4:                       # host:port:user:pass
            host, port, user, pw = parts
            value = f"http://{user}:{pw}@{host}:{port}"
        else:
            value = "http://" + value
    return value


PROXY = _load_proxy()
BASE = "https://www.lancers.jp"
SEARCH_URL = BASE + "/profile/search?industry_type_id=&type=&visited=&age=&gender=&not=&keyword=&page={page}"
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/130.0.0.0 Safari/537.36")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
STATE = os.path.join(DATA, "_state")
os.makedirs(STATE, exist_ok=True)
LINKS_FILE = os.path.join(STATE, "profile_links.json")
PROFILES_FILE = os.path.join(STATE, "profiles.jsonl")     # append-only checkpoint
FAILED_FILE = os.path.join(STATE, "failed.json")
CSV_OUT = os.path.join(DATA, "lancers_profiles.csv")
JSON_OUT = os.path.join(DATA, "lancers_profiles.json")

WORKERS = int(os.environ.get("LANCERS_WORKERS", "3"))
# Shared pace across all workers: one request every INTERVAL seconds (randomised +-20%).
# Lancers sits behind AWS WAF, which starts serving a CAPTCHA when traffic gets too dense,
# so the pace slows down automatically each time that happens.
INTERVAL = float(os.environ.get("LANCERS_INTERVAL", "4"))
MAX_INTERVAL = 15.0
WAF_COOLDOWNS = [600, 900, 1200, 1800]   # pause lengths (s) after consecutive CAPTCHA hits
MAX_RETRY = 60   # proxy drops connections in short windows; keep trying
JST = timezone(timedelta(hours=9))

FIELDS = [
    "username", "display_name", "profile_url", "avatar_url",
    "rank", "rank_code", "entity_type", "job_category", "prefecture",
    "orders", "tasks", "good_reviews", "bad_reviews", "completion_rate",
    "task_approval_rate", "repeaters", "external_achievements",
    "last_login_text", "last_login_minutes", "availability",
    "registered_date", "registered_days_ago",
    "identity_verified", "nda_verified", "phone_verified", "lancers_check",
    "invoice_ready", "video_meeting", "beginner_friendly",
    "badges", "categories", "categories_proven", "industries", "industries_proven", "skills",
    "hourly_rate", "reply_rate_24h", "catchphrase", "scraped_at",
]

_opener = urllib.request.build_opener(
    urllib.request.ProxyHandler({"http": PROXY, "https": PROXY}))
_lock = threading.Lock()
_log_lock = threading.Lock()


def log(*a):
    with _log_lock:
        print(datetime.now().strftime("%H:%M:%S"), *a, flush=True)


_pace = {"next": 0.0, "interval": INTERVAL}
_pace_lock = threading.Lock()
_waf = {"until": 0.0, "step": 0, "ok": 0}   # ok = successful requests since the last block
_waf_lock = threading.Lock()


def _throttle():
    """Space requests out across all threads."""
    with _pace_lock:
        now = time.time()
        t = max(now, _pace["next"])
        _pace["next"] = t + _pace["interval"] * (0.8 + random.random() * 0.4)
    if t > now:
        time.sleep(t - now)


def _waf_wait():
    """Block while a CAPTCHA cool-down is in effect."""
    while True:
        with _waf_lock:
            remaining = _waf["until"] - time.time()
        if remaining <= 0:
            return
        time.sleep(min(remaining, 15))


def _waf_hit(url):
    with _waf_lock:
        now = time.time()
        if _waf["until"] > now:          # another worker already started this pause
            return
        # a block counts as traffic-triggered only if real requests succeeded before it
        # (not a probe during an ongoing block, nor the first request after a restart)
        fresh = _waf["step"] == 0 and _waf["ok"] > 0
        _waf["ok"] = 0
        cd = WAF_COOLDOWNS[min(_waf["step"], len(WAF_COOLDOWNS) - 1)]
        _waf["step"] += 1
        _waf["until"] = now + cd
    with _pace_lock:
        if fresh:                         # only real traffic-triggered blocks slow the pace
            _pace["interval"] = min(MAX_INTERVAL, _pace["interval"] * 1.5)
        iv = _pace["interval"]
    log(f"WAF CAPTCHA from lancers.jp on {url[-45:]} -> pausing all requests {cd // 60} min, "
        f"then 1 request / {iv:.1f}s")


def _waf_clear():
    with _waf_lock:
        if _waf["step"]:
            log("WAF block cleared, resuming")
        _waf["step"] = 0
        _waf["ok"] += 1
        ok = _waf["ok"]
    if ok % 200 == 0:                     # sustained success: speed back up slowly, never below INTERVAL
        with _pace_lock:
            if _pace["interval"] > INTERVAL:
                _pace["interval"] = max(INTERVAL, _pace["interval"] * 0.9)
                log(f"pace recovered to 1 request / {_pace['interval']:.1f}s")


def fetch(url, tries=MAX_RETRY):
    """GET url through the proxy. Proxy hiccups are retried quickly; a WAF CAPTCHA
    pauses every worker for a cool-down and is never counted as a failure."""
    last = None
    attempt = 0
    while attempt < tries:
        _waf_wait()
        _throttle()
        waf = False
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA, "Accept-Language": "ja,en;q=0.8",
                "Accept-Encoding": "gzip",
                "Accept": "text/html,application/xhtml+xml,*/*;q=0.8"})
            with _opener.open(req, timeout=45) as r:
                if r.headers.get("x-amzn-waf-action"):
                    waf = True
                else:
                    raw = r.read()
                    if (r.headers.get("Content-Encoding") or "").lower() == "gzip":
                        raw = gzip.decompress(raw)
                    _waf_clear()
                    return r.status, raw.decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            if e.headers.get("x-amzn-waf-action") or e.code == 405:
                waf = True
            elif e.code == 404:
                return 404, ""
            else:
                last = f"HTTP {e.code}"
                if e.code in (403, 429, 503):
                    time.sleep(15 * min(attempt + 1, 4))
        except Exception as e:  # proxy 403 on CONNECT, timeouts, resets...
            last = repr(e)
        if waf:
            _waf_hit(url)
            continue                      # wait out the cool-down, do not count it
        attempt += 1
        # the proxy refuses CONNECTs in ~10 s windows every ~25 s: retry soon, back off only later
        wait = (3 if attempt < 12 else min(30, 5 + attempt)) + random.random() * 2
        if attempt >= 6:
            log(f"retry {attempt}/{tries} in {wait:.0f}s ({last}) {url[-60:]}")
        time.sleep(wait)
    raise RuntimeError(f"giving up on {url}: {last}")


# --------------------------------------------------------- phase 1: links ---
def links_on_page(html):
    soup = BeautifulSoup(html, "html.parser")
    out = []
    for a in soup.select("a.p-search-talent__media-description-text[href]"):
        href = a["href"].strip()
        if href.startswith("/profile/"):
            out.append(href.split("?")[0])
    return out


def page_links(page):
    status, html = fetch(SEARCH_URL.format(page=page))
    return links_on_page(html) if status == 200 else []


def find_last_page(hint=600):
    """Exponential then binary search for the last page that still lists profiles."""
    lo, hi = 1, hint
    while page_links(hi):
        lo, hi = hi, hi * 2
        log(f"probe page {lo}: has results, trying {hi}")
    while hi - lo > 1:
        mid = (lo + hi) // 2
        has = bool(page_links(mid))
        log(f"probe page {mid}: {'results' if has else 'empty'}")
        if has:
            lo = mid
        else:
            hi = mid
    return lo


def collect_links(start=1, stop=None):
    state = {"pages": {}, "done": False}
    if os.path.exists(LINKS_FILE):
        state = json.load(open(LINKS_FILE, encoding="utf-8"))
    if state.get("done"):
        log("links already collected:", sum(len(v) for v in state["pages"].values()))
        return state
    last = stop or state.get("last_page") or find_last_page()
    state["last_page"] = last
    log(f"last search page: {last}")
    todo = [p for p in range(start, last + 1) if str(p) not in state["pages"] or not state["pages"][str(p)]]
    log(f"fetching {len(todo)} search pages with {WORKERS} workers")
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(page_links, p): p for p in todo}
        for i, fut in enumerate(as_completed(futs), 1):
            p = futs[fut]
            try:
                hrefs = fut.result()
            except Exception as e:
                log(f"page {p} FAILED: {e}")
                continue                  # leave it unfetched; the next run retries it
            with _lock:
                state["pages"][str(p)] = hrefs
                if i % 10 == 0 or i == len(todo):
                    total = sum(len(v) for v in state["pages"].values())
                    log(f"  search pages {i}/{len(todo)} (links so far {total})")
                    json.dump(state, open(LINKS_FILE, "w", encoding="utf-8"), ensure_ascii=False)
    # pages that came back empty (but were fetched) get one more try
    for p in [p for p in range(start, last + 1) if str(p) in state["pages"] and not state["pages"][str(p)]]:
        try:
            state["pages"][str(p)] = page_links(p)
            log(f"re-check page {p}: {len(state['pages'][str(p)])} links")
        except Exception as e:
            log(f"re-check page {p} FAILED: {e}")
            state["pages"].pop(str(p), None)
    missing = [p for p in range(start, last + 1) if str(p) not in state["pages"]]
    if missing:
        log(f"{len(missing)} search pages still missing ({missing[:10]}...); re-run to fetch them")
        json.dump(state, open(LINKS_FILE, "w", encoding="utf-8"), ensure_ascii=False)
        return state
    # the very last pages may legitimately be empty if the index shrank; trim them
    while last > 1 and not state["pages"].get(str(last)):
        last -= 1
    state["last_page"] = last
    state["done"] = True
    json.dump(state, open(LINKS_FILE, "w", encoding="utf-8"), ensure_ascii=False)
    return state


# ------------------------------------------------------ phase 2: profiles ---
def txt(el):
    return re.sub(r"\s+", " ", el.get_text(" ", strip=True)).strip() if el else ""


def num(s):
    m = re.search(r"-?[\d,]+(?:\.\d+)?", s or "")
    return m.group(0).replace(",", "") if m else ""


def login_minutes(text):
    """'30分前' -> 30, '3時間前' -> 180, '5日前' -> 7200, '30日以上前' -> 43200 ..."""
    t = text or ""
    m = re.search(r"(\d+)\s*(分|時間|日|週間|ヶ月|か月|ヵ月|年)", t)
    if not m:
        if "たった今" in t or "数秒" in t or "オンライン" in t:
            return 0
        return ""
    n = int(m.group(1)); u = m.group(2)
    mult = {"分": 1, "時間": 60, "日": 1440, "週間": 10080, "ヶ月": 43200, "か月": 43200, "ヵ月": 43200, "年": 525600}[u]
    return n * mult


def jp_date(text):
    m = re.search(r"(\d{4})年(\d{1,2})月(\d{1,2})日", text or "")
    if not m:
        return ""
    return f"{int(m.group(1)):04d}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"


def tagged_list(dd):
    """Return (all names, names marked 実績あり/認定) for a 得意な〜 definition block."""
    names, proven = [], []
    items = dd.select("a.js-introduction-list-link") or dd.select("a") or dd.select("div")
    for it in items:
        has_check = bool(it.select_one("i.c-icon--check"))
        for t in it.select(".c-tooltip"):
            t.decompose()
        name = txt(it)
        if not name or name in names:
            continue
        names.append(name)
        if has_check:
            proven.append(name)
    return names, proven


RANK_MAP = {  # badge css modifier -> label
    "authorized": "認定ランサー",
    "certified": "認証ランサー",
    "silver": "シルバーランサー",
    "bronze": "ブロンズランサー",
    "regular": "レギュラーランサー",
}


def parse_profile(username, html):
    soup = BeautifulSoup(html, "html.parser")
    row = {k: "" for k in FIELDS}
    row["username"] = username
    row["profile_url"] = f"{BASE}/profile/{username}"
    row["scraped_at"] = datetime.now(JST).strftime("%Y-%m-%d %H:%M:%S")

    media = soup.select_one(".p-profile-media")
    if not media:
        raise ValueError("no .p-profile-media (not a profile page?)")

    row["display_name"] = txt(media.select_one(".p-profile-media__heading"))
    img = media.select_one("img.p-profile-media__avatar-image")
    row["avatar_url"] = (img.get("src") or "").strip() if img else ""
    if row["avatar_url"].startswith("//"):
        row["avatar_url"] = "https:" + row["avatar_url"]
    row["catchphrase"] = txt(media.select_one(".p-profile-media__sub-title"))
    row["last_login_text"] = txt(media.select_one(".c-login-status"))
    row["last_login_minutes"] = login_minutes(row["last_login_text"])

    # notes: nickname / job category / 法人|個人 / prefecture / invoice / video
    for li in media.select("li.p-profile-media__note"):
        t = txt(li)
        a = li.select_one("a[href]")
        href = a["href"] if a else ""
        if "job=" in href:
            row["job_category"] = t
        elif "prefecture" in href:
            row["prefecture"] = t
        elif t in ("法人", "個人"):
            row["entity_type"] = t
        elif "適格請求書" in t:
            row["invoice_ready"] = "1"
        elif "ビデオ面談" in t:
            row["video_meeting"] = "1"
    row["invoice_ready"] = row["invoice_ready"] or "0"
    row["video_meeting"] = row["video_meeting"] or "0"

    # rank + other badges
    badges = []
    rank_code = ""
    for b in soup.select(".p-profile-lancer-badges .p-profile-lancer-badge"):
        cls = " ".join(b.get("class", []))
        if "p-profile-lancer-badge--user-rank" in cls:
            m = re.search(r"c-badge--(\w+)", cls.replace("c-badge--has-complement", ""))
            rank_code = m.group(1) if m else ""
            label = txt(b.select_one(".p-profile-lancer-badge__text-span"))
            row["rank"] = label or RANK_MAP.get(rank_code, rank_code)
        else:
            alt = (b.select_one("img") or {}).get("alt") if b.select_one("img") else ""
            comp = txt(b.select_one(".c-badge__complement-text, .c-badge__complement"))
            if "初心者" in comp:
                row["beginner_friendly"] = "1"
                badges.append("初心者にやさしい")
            elif alt:
                badges.append(alt.strip())
            else:
                m = re.search(r"c-badge--([\w\-]+)", cls.replace("c-badge--has-complement", ""))
                if m:
                    badges.append(m.group(1))
    row["rank_code"] = rank_code
    row["beginner_friendly"] = row["beginner_friendly"] or "0"
    row["badges"] = "|".join(dict.fromkeys(badges))

    # verification statuses
    for li in soup.select(".p-profile-header__status-list .p-profile-header__status"):
        t = txt(li)
        icon = li.select_one("i")
        ok = "1" if icon and "c-icon--green" in " ".join(icon.get("class", [])) else "0"
        if "本人確認" in t: row["identity_verified"] = ok
        elif "機密保持" in t: row["nda_verified"] = ok
        elif "電話確認" in t: row["phone_verified"] = ok
        elif "ランサーズチェック" in t: row["lancers_check"] = ok
    for k in ("identity_verified", "nda_verified", "phone_verified", "lancers_check"):
        row[k] = row[k] or "0"

    # summary table: 実績数 / 評価 / 完了率 / リピーター / 外部実績
    for col in soup.select(".p-profile-header-summary .c-table-summary__col-item"):
        head = txt(col.select_one(".c-table-summary__col-head"))
        if head.startswith("実績数"):
            row["orders"] = num(txt(col.select_one(".p-profile-header-summary__description-text")))
            for note in col.select(".c-table-summary__col-note"):
                nt = txt(note)
                if "タスク数" in nt:
                    row["tasks"] = num(nt)
        elif head.startswith("評価"):
            for item in col.select(".p-profile-header-summary__description-item"):
                icon = item.select_one("i")
                ic = " ".join(icon.get("class", [])) if icon else ""
                v = num(txt(item.select_one(".p-profile-header-summary__description-text")))
                if "smile" in ic:
                    row["good_reviews"] = v
                elif "sad" in ic:
                    row["bad_reviews"] = v
        elif head.startswith("完了率"):
            row["completion_rate"] = num(txt(col.select_one(".p-profile-header-summary__description-text")))
            for note in col.select(".c-table-summary__col-note"):
                nt = txt(note)
                if "タスク承認率" in nt:
                    row["task_approval_rate"] = num(nt)
        elif head.startswith("リピーター"):
            row["repeaters"] = num(txt(col.select_one(".p-profile-header-summary__description-text")))
        elif head.startswith("外部実績"):
            row["external_achievements"] = num(txt(col.select_one(".p-profile-header-summary__description-text")))

    # introduction definition list
    for dt in soup.select("dt.p-profile-introduction__list-term"):
        term = txt(dt)
        term = re.split(r"\s", term)[0] if term else ""
        dd = dt.find_next_sibling("dd")
        if not dd:
            continue
        if term.startswith("稼働時間"):
            row["availability"] = txt(dd)
        elif term.startswith("稼働単価"):
            rates = []
            for r_ in dd.select(".p-profile-index__timecharge_rate"):
                rates.append(f"{txt(r_.select_one('.p-profile-index__timecharge_rate_content')).rstrip(':：')}:{num(txt(r_.select_one('.p-profile-index__timecharge_rate_price')))}")
            row["hourly_rate"] = "|".join(rates) if rates else num(txt(dd))
        elif term.startswith("得意なカテゴリ"):
            names, proven = tagged_list(dd)
            row["categories"] = "|".join(names)
            row["categories_proven"] = "|".join(proven)
        elif term.startswith("得意な業種"):
            names, proven = tagged_list(dd)
            row["industries"] = "|".join(names)
            row["industries_proven"] = "|".join(proven)
        elif term.startswith("得意なスキル"):
            names, _ = tagged_list(dd)
            row["skills"] = "|".join(names)
        elif "返信率" in term:
            row["reply_rate_24h"] = num(txt(dd))
        elif term.startswith("登録日"):
            row["registered_date"] = jp_date(txt(dd))
    if row["registered_date"]:
        d = datetime.strptime(row["registered_date"], "%Y-%m-%d").date()
        row["registered_days_ago"] = (datetime.now(JST).date() - d).days

    # fallback for availability via the no-login message box
    if not row["availability"]:
        m = re.search(r"稼働状況：\s*([^<\n]+)", html)
        if m:
            row["availability"] = m.group(1).strip()
    return row


def scrape_profile(href):
    username = href.rsplit("/", 1)[-1]
    status, html = fetch(BASE + href)
    if status == 404:
        return {"username": username, "_error": "404"}
    return parse_profile(username, html)


def load_done():
    done = {}
    if os.path.exists(PROFILES_FILE):
        with open(PROFILES_FILE, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    r = json.loads(line)
                    done[r["username"]] = r
    return done


def collect_profiles(hrefs):
    done = load_done()
    todo = [h for h in dict.fromkeys(hrefs) if h.rsplit("/", 1)[-1] not in done]
    log(f"profiles: {len(done)} done, {len(todo)} to go")
    failed = {}
    out = open(PROFILES_FILE, "a", encoding="utf-8")
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(scrape_profile, h): h for h in todo}
        for i, fut in enumerate(as_completed(futs), 1):
            h = futs[fut]
            try:
                row = fut.result()
                with _lock:
                    out.write(json.dumps(row, ensure_ascii=False) + "\n")
                    out.flush()
                    done[row["username"]] = row
            except Exception as e:
                failed[h] = str(e)
                log("FAILED", h, e)
            if i % 25 == 0:
                log(f"  {i}/{len(todo)} fetched ({len(failed)} failed)")
            if i % 250 == 0:
                export(done)              # partial CSV so the site has data during long runs
    out.close()
    json.dump(failed, open(FAILED_FILE, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    return done, failed


def export(done):
    rows = [r for r in done.values() if not r.get("_error")]
    rows.sort(key=lambda r: (r.get("registered_date") or "", r["username"]), reverse=True)
    with open(CSV_OUT, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k, "") for k in FIELDS})
    json.dump(rows, open(JSON_OUT, "w", encoding="utf-8"), ensure_ascii=False)
    # copy next to the site so web/ can be deployed as-is (Vercel, Netlify, ...)
    web_data = os.path.join(ROOT, "web", "data")
    os.makedirs(web_data, exist_ok=True)
    import shutil
    shutil.copyfile(CSV_OUT, os.path.join(web_data, "lancers_profiles.csv"))
    log(f"exported {len(rows)} rows -> {CSV_OUT}")


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--links-only", action="store_true")
    ap.add_argument("--export-only", action="store_true")
    ap.add_argument("--stop-page", type=int, default=None, help="debug: stop after this search page")
    ap.add_argument("--limit", type=int, default=None, help="debug: scrape at most N profiles")
    args = ap.parse_args()
    if args.export_only:
        export(load_done()); sys.exit(0)
    state = collect_links(stop=args.stop_page)
    hrefs = [h for p in sorted(state["pages"], key=int) for h in state["pages"][p]]
    hrefs = list(dict.fromkeys(hrefs))
    log(f"unique profile links: {len(hrefs)}")
    if args.links_only:
        sys.exit(0)
    if args.limit:
        hrefs = hrefs[: args.limit]
    done, failed = collect_profiles(hrefs)
    export(done)
    if failed:
        log(f"{len(failed)} profiles failed; re-run the script to retry them")
