/* Lancers 名鑑 — client-side search app over the scraped CSV.
   No build step, no dependencies. The CSV is the database. */
(() => {
  "use strict";

  // ------------------------------------------------------------ config ----
  const DATA_URLS = ["data/lancers_profiles.csv", "../data/lancers_profiles.csv", "data/sample_profiles.csv"];
  const PAGE_SIZE = 30;
  const LS_CHECK = "lancers-meikan:checked";      // ✔ マークの保存先 (localStorage)
  const RANK_ORDER = ["認定ランサー", "認証ランサー", "シルバーランサー", "ブロンズランサー", "レギュラーランサー", "未設定"];
  const RANK_CODE = { "認定ランサー": "authorized", "認証ランサー": "certified", "シルバーランサー": "silver", "ブロンズランサー": "bronze", "レギュラーランサー": "regular", "未設定": "none" };
  const FLAGS = [
    ["identity_verified", "本人確認"], ["nda_verified", "機密保持確認"], ["phone_verified", "電話確認"],
    ["lancers_check", "ランサーズチェック"], ["invoice_ready", "適格請求書対応"], ["video_meeting", "ビデオ面談対応"],
    ["beginner_friendly", "初心者にやさしい"],
  ];
  const NUM_FIELDS = ["orders", "tasks", "good_reviews", "bad_reviews", "completion_rate", "task_approval_rate", "repeaters",
    "external_achievements", "last_login_minutes", "registered_days_ago", "reply_rate_24h"];

  // ------------------------------------------------------------- state ----
  let ROWS = [];                 // all profiles
  let FILTERED = [];             // current result
  let page = 1;
  let checked = loadChecked();
  const facetSelections = {     // facet id -> Set of selected values
    rank: new Set(), entity: new Set(), availability: new Set(), job: new Set(), prefecture: new Set(),
    categories: new Set(), industries: new Set(), skills: new Set(), flags: new Set(), badges: new Set(),
  };
  const facetField = { rank: "rank", entity: "entity_type", availability: "availability_label", job: "job_category",
    prefecture: "prefecture", categories: "categories_list", industries: "industries_list", skills: "skills_list",
    flags: "flags_list", badges: "badges_list" };
  const facetLabel = { rank: "ランク", entity: "法人/個人", availability: "稼働状況", job: "職種", prefecture: "都道府県",
    categories: "カテゴリ", industries: "業種", skills: "スキル", flags: "認証", badges: "バッジ" };
  const facetShowAll = {};       // facet id -> bool (expanded list)
  const facetQuery = {};         // facet id -> search text

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));

  // --------------------------------------------------------------- CSV ----
  function parseCSV(text) {
    const rows = []; let row = [], field = "", i = 0, inQ = false;
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    while (i < text.length) {
      const c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
        field += c; i++; continue;
      }
      if (c === '"') { inQ = true; i++; continue; }
      if (c === ",") { row.push(field); field = ""; i++; continue; }
      if (c === "\r") { i++; continue; }
      if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
      field += c; i++;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    const head = rows.shift();
    return rows.filter(r => r.length > 1).map(r => Object.fromEntries(head.map((h, k) => [h, r[k] ?? ""])));
  }

  async function loadData() {
    for (const url of DATA_URLS) {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) continue;
        const text = await res.text();
        if (!text.trim()) continue;
        return { rows: parseCSV(text), url, modified: res.headers.get("last-modified") };
      } catch (e) { /* try next */ }
    }
    throw new Error("CSV が見つかりません (data/lancers_profiles.csv)");
  }

  // ---------------------------------------------------------- derive ----
  const splitList = s => (s || "").split("|").map(x => x.trim()).filter(Boolean);
  const toNum = v => (v === "" || v == null || isNaN(+v)) ? null : +v;

  function availabilityLabel(a) {
    const t = a || "";
    if (!t) return "未設定";
    if (t.includes("対応可能")) return "対応可能";
    if (t.includes("副業")) return "副業で対応可能";
    if (t.includes("仕事内容")) return "仕事内容による";
    if (t.includes("忙しい") || t.includes("対応不可") || t.includes("休止")) return "現在忙しい";
    return t.replace(/\s*\(.*?\)\s*$/, "") || "未設定";
  }

  function enrich(r) {
    NUM_FIELDS.forEach(f => r[f] = toNum(r[f]));
    r.rank = r.rank || "未設定";
    r.rank_code = r.rank_code || RANK_CODE[r.rank] || "none";
    r.entity_type = r.entity_type || "不明";
    r.availability_label = availabilityLabel(r.availability);
    r.categories_list = splitList(r.categories);
    r.categories_proven_list = splitList(r.categories_proven);
    r.industries_list = splitList(r.industries);
    r.industries_proven_list = splitList(r.industries_proven);
    r.skills_list = splitList(r.skills).map(s => s.replace(/\s+\d+年(以上)?$/, "").replace(/\s+\d+ヶ月$/, "").trim());
    r.skills_raw_list = splitList(r.skills);
    r.badges_list = splitList(r.badges);
    r.flags_list = FLAGS.filter(([k]) => r[k] === "1").map(([, label]) => label);
    r.rates = splitList(r.hourly_rate).map(x => { const [k, v] = x.split(":"); return { label: k, value: toNum(v) }; });
    const base = r.rates.find(x => /基本/.test(x.label)) || r.rates[0];
    r.base_rate = base ? base.value : null;
    // registration date normalised to days (recomputed from today, not from scrape time)
    if (r.registered_date) {
      const d = new Date(r.registered_date + "T00:00:00+09:00");
      r.registered_ts = d.getTime();
      r.registered_days_ago = Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
    } else { r.registered_ts = null; r.registered_days_ago = null; }
    r._search = {
      all: [r.display_name, r.username, r.catchphrase, r.job_category, r.prefecture, r.categories, r.industries, r.skills, r.rank, r.entity_type, r.badges].join(" ").toLowerCase(),
      display_name: (r.display_name || "").toLowerCase(), username: (r.username || "").toLowerCase(),
      catchphrase: (r.catchphrase || "").toLowerCase(), job_category: (r.job_category || "").toLowerCase(),
      categories: (r.categories || "").toLowerCase(), skills: (r.skills || "").toLowerCase(),
      industries: (r.industries || "").toLowerCase(), prefecture: (r.prefecture || "").toLowerCase(),
    };
    return r;
  }

  // -------------------------------------------------------- keyword q ----
  // grammar: space = AND, "OR" = OR, -term = NOT, "phrase" = exact phrase
  function parseQuery(q) {
    const tokens = (q.match(/-?"[^"]+"|\S+/g) || []).map(t => t.trim()).filter(Boolean);
    const groups = [[]]; // OR groups of AND terms
    const nots = [];
    for (let t of tokens) {
      if (/^or$/i.test(t)) { groups.push([]); continue; }
      let neg = false;
      if (t.startsWith("-") && t.length > 1) { neg = true; t = t.slice(1); }
      t = t.replace(/^"|"$/g, "").toLowerCase();
      if (!t) continue;
      (neg ? nots : groups[groups.length - 1]).push(t);
    }
    return { groups: groups.filter(g => g.length), nots };
  }
  function matchQuery(r, pq, target) {
    const hay = r._search[target] || r._search.all;
    if (pq.nots.some(n => hay.includes(n))) return false;
    if (!pq.groups.length) return true;
    return pq.groups.some(g => g.every(t => hay.includes(t)));
  }

  // ---------------------------------------------------------- filters ----
  function readRange(minEl, maxEl) {
    const mn = toNum(minEl.value), mx = toNum(maxEl.value);
    return (mn == null && mx == null) ? null : [mn, mx];
  }
  function inRange(v, range) {
    if (!range) return true;
    if (v == null) return false;
    const [mn, mx] = range;
    return (mn == null || v >= mn) && (mx == null || v <= mx);
  }

  function currentCriteria() {
    const c = {};
    c.q = $("#q").value.trim();
    c.qt = ($('input[name="qt"]:checked') || {}).value || "all";
    c.pq = parseQuery(c.q);
    c.check = ($('input[name="check"]:checked') || {}).value || "";
    // registration
    const preset = ($('input[name="regpreset"]:checked') || {}).value || "";
    let regRange = readRange($("#reg_min"), $("#reg_max"));
    if (preset) { const [a, b] = preset.split("-"); regRange = [toNum(a), b === "" ? null : toNum(b)]; }
    c.regRange = regRange;
    c.regFrom = $("#reg_from").value ? new Date($("#reg_from").value + "T00:00:00+09:00").getTime() : null;
    c.regTo = $("#reg_to").value ? new Date($("#reg_to").value + "T23:59:59+09:00").getTime() : null;
    // login
    const lp = ($('input[name="loginpreset"]:checked') || {}).value || "";
    let loginRange = null;
    if (lp) { const [a, b] = lp.split("-"); loginRange = [toNum(a), b === "" ? null : toNum(b)]; }
    const ld = toNum($("#login_max_days").value);
    if (ld != null) loginRange = [0, ld * 1440];
    c.loginRange = loginRange;
    // numbers
    c.nums = {};
    $$("#f_numbers input[data-num]").forEach(inp => {
      const f = inp.dataset.num; c.nums[f] = c.nums[f] || [null, null];
      c.nums[f][inp.dataset.side === "min" ? 0 : 1] = toNum(inp.value);
    });
    Object.keys(c.nums).forEach(f => { if (c.nums[f][0] == null && c.nums[f][1] == null) delete c.nums[f]; });
    c.mode = { categories: modeOf("categories"), industries: modeOf("industries"), skills: modeOf("skills") };
    c.proven = { categories: $("#proven_categories").checked, industries: $("#proven_industries").checked };
    return c;
  }
  const modeOf = id => ($(`input[name="mode_${id}"]:checked`) || {}).value || "or";

  function passesFacet(r, id, c) {
    const sel = facetSelections[id];
    if (!sel.size) return true;
    const field = facetField[id];
    const v = r[field];
    if (Array.isArray(v)) {
      let list = v;
      if (c.proven[id]) list = r[id + "_proven_list"] || v;
      const mode = id === "flags" ? "and" : (c.mode[id] || "or");
      return mode === "and" ? [...sel].every(x => list.includes(x)) : [...sel].some(x => list.includes(x));
    }
    return sel.has(v);
  }

  function passesAll(r, c, skipFacet) {
    if (c.q && !matchQuery(r, c.pq, c.qt)) return false;
    if (c.check === "1" && !checked.has(r.username)) return false;
    if (c.check === "0" && checked.has(r.username)) return false;
    if (c.regRange && !inRange(r.registered_days_ago, c.regRange)) return false;
    if (c.regFrom != null && (r.registered_ts == null || r.registered_ts < c.regFrom)) return false;
    if (c.regTo != null && (r.registered_ts == null || r.registered_ts > c.regTo)) return false;
    if (c.loginRange && !inRange(r.last_login_minutes, c.loginRange)) return false;
    for (const f in c.nums) if (!inRange(r[f], c.nums[f])) return false;
    for (const id in facetSelections) if (id !== skipFacet && !passesFacet(r, id, c)) return false;
    return true;
  }

  function sortRows(rows) {
    const s = $("#sort").value;
    const nz = (v, d) => (v == null ? d : v);
    const cmp = {
      registered_desc: (a, b) => nz(b.registered_ts, -1) - nz(a.registered_ts, -1),
      registered_asc: (a, b) => nz(a.registered_ts, Infinity) - nz(b.registered_ts, Infinity),
      login_asc: (a, b) => nz(a.last_login_minutes, Infinity) - nz(b.last_login_minutes, Infinity),
      orders_desc: (a, b) => nz(b.orders, -1) - nz(a.orders, -1),
      good_desc: (a, b) => nz(b.good_reviews, -1) - nz(a.good_reviews, -1),
      bad_desc: (a, b) => nz(b.bad_reviews, -1) - nz(a.bad_reviews, -1),
      repeaters_desc: (a, b) => nz(b.repeaters, -1) - nz(a.repeaters, -1),
      rate_desc: (a, b) => nz(b.base_rate, -1) - nz(a.base_rate, -1),
      rate_asc: (a, b) => nz(a.base_rate, Infinity) - nz(b.base_rate, Infinity),
      name_asc: (a, b) => (a.display_name || "").localeCompare(b.display_name || "", "ja"),
    }[s] || (() => 0);
    return rows.slice().sort(cmp);
  }

  // ------------------------------------------------------------ apply ----
  let applyTimer = null;
  function scheduleApply() { clearTimeout(applyTimer); applyTimer = setTimeout(apply, 60); }

  function apply(resetPage = true) {
    const c = currentCriteria();
    FILTERED = sortRows(ROWS.filter(r => passesAll(r, c)));
    if (resetPage) page = 1;
    renderFacets(c);
    renderActive(c);
    renderCards();
    writeHash(c);
  }

  // ----------------------------------------------------------- facets ----
  function countBy(rows, field) {
    const m = new Map();
    for (const r of rows) {
      const v = r[field];
      if (Array.isArray(v)) { for (const x of new Set(v)) m.set(x, (m.get(x) || 0) + 1); }
      else if (v != null && v !== "") m.set(v, (m.get(v) || 0) + 1);
    }
    return m;
  }

  function renderFacets(c) {
    for (const id in facetSelections) {
      const el = $("#f_" + id); if (!el) continue;
      const field = facetField[id];
      // counts are computed on rows passing every OTHER filter (standard faceted search)
      const base = ROWS.filter(r => passesAll(r, c, id));
      const counts = countBy(base, field);
      let values = [...new Set([...counts.keys(), ...facetSelections[id]])];
      if (id === "rank") values.sort((a, b) => RANK_ORDER.indexOf(a) - RANK_ORDER.indexOf(b));
      else if (id === "flags") values = FLAGS.map(f => f[1]);
      else values.sort((a, b) => (counts.get(b) || 0) - (counts.get(a) || 0) || a.localeCompare(b, "ja"));
      const q = (facetQuery[id] || "").toLowerCase();
      if (q) values = values.filter(v => v.toLowerCase().includes(q));
      const LIMIT = 8;
      const expandable = ["job", "prefecture", "categories", "industries", "skills", "badges"].includes(id);
      const show = (expandable && !facetShowAll[id] && !q) ? values.slice(0, LIMIT) : values;
      el.innerHTML = show.map(v => {
        const n = counts.get(v) || 0, on = facetSelections[id].has(v);
        return `<label class="${n === 0 && !on ? "is-zero" : ""}"><input type="checkbox" data-facet="${id}" value="${esc(v)}" ${on ? "checked" : ""}><span class="name" title="${esc(v)}">${esc(v)}</span><span class="n">${n.toLocaleString()}</span></label>`;
      }).join("") + (expandable && values.length > LIMIT && !q
        ? `<button class="more" data-more="${id}">${facetShowAll[id] ? "閉じる" : `すべて表示（${values.length}）`}</button>` : "");
    }
    const n1 = ROWS.filter(r => checked.has(r.username) && passesAll(r, { ...c, check: "" }, "__none")).length;
    $("#cnt_check1").textContent = n1 ? n1.toLocaleString() : "";
  }

  // ----------------------------------------------------- active chips ----
  function renderActive(c) {
    const chips = [];
    if (c.q) chips.push({ label: `キーワード: ${c.q}`, clear: () => { $("#q").value = ""; } });
    if (c.check === "1") chips.push({ label: "✔ 付きのみ", clear: () => { $('input[name="check"][value=""]').checked = true; } });
    if (c.check === "0") chips.push({ label: "未チェックのみ", clear: () => { $('input[name="check"][value=""]').checked = true; } });
    if (c.regRange) chips.push({ label: `登録: ${rangeText(c.regRange, "日")}`, clear: () => { $('input[name="regpreset"][value=""]').checked = true; $("#reg_min").value = ""; $("#reg_max").value = ""; } });
    if (c.regFrom != null || c.regTo != null) chips.push({ label: `登録期間: ${$("#reg_from").value || "…"} 〜 ${$("#reg_to").value || "…"}`, clear: () => { $("#reg_from").value = ""; $("#reg_to").value = ""; } });
    if (c.loginRange) chips.push({ label: `最終ログイン: ${loginRangeText(c.loginRange)}`, clear: () => { $('input[name="loginpreset"][value=""]').checked = true; $("#login_max_days").value = ""; } });
    const numLabel = { orders: "受注数", tasks: "タスク数", good_reviews: "良い評価", bad_reviews: "悪い評価", completion_rate: "完了率", repeaters: "リピーター", reply_rate_24h: "返信率", base_rate: "基本単価" };
    for (const f in c.nums) chips.push({ label: `${numLabel[f] || f}: ${rangeText(c.nums[f], "")}`, clear: () => $$(`#f_numbers input[data-num="${f}"]`).forEach(i => i.value = "") });
    for (const id in facetSelections) for (const v of facetSelections[id]) {
      chips.push({ label: `${facetLabel[id]}: ${v}`, clear: () => facetSelections[id].delete(v) });
    }
    const box = $("#activeFilters");
    box.innerHTML = chips.map((ch, i) => `<span class="tag-active">${esc(ch.label)}<button data-clear="${i}" aria-label="解除">×</button></span>`).join("");
    box._chips = chips;
  }
  const rangeText = ([a, b], unit) => a != null && b != null ? `${a}〜${b}${unit}` : a != null ? `${a}${unit}以上` : `${b}${unit}以下`;
  const loginRangeText = ([a, b]) => b == null ? `${Math.round(a / 1440)}日以上前` : b < 1440 ? `${Math.round(b / 60)}時間以内` : `${Math.round((b + 1) / 1440)}日以内`;

  // ------------------------------------------------------------ cards ----
  function renderCards() {
    const total = FILTERED.length;
    $("#countShown").textContent = total.toLocaleString();
    $("#countTotal").textContent = ROWS.length.toLocaleString();
    $("#empty").hidden = total > 0;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    page = Math.min(page, pages);
    const slice = FILTERED.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    const tpl = $("#tplCard");
    const frag = document.createDocumentFragment();
    slice.forEach((r, i) => {
      const node = tpl.content.firstElementChild.cloneNode(true);
      const card = $(".card", node);
      card.dataset.user = r.username;
      card.style.animationDelay = `${Math.min(i, 12) * 40}ms`;
      card.classList.toggle("is-checked", checked.has(r.username));
      const img = $("img", node); img.src = r.avatar_url || ""; img.alt = r.display_name;
      img.onerror = () => { img.onerror = null; img.src = avatarFallback(r.display_name); };
      $(".avatar__dot", node).className = "avatar__dot " + loginDotClass(r.last_login_minutes);
      $(".card__name", node).textContent = r.display_name || r.username;
      $(".card__sub", node).textContent = [r.job_category, r.prefecture].filter(Boolean).join(" / ") + (r.username ? ` ・ @${r.username}` : "");
      $(".card__rank-text", node).innerHTML = `<i class="rank-ic rank--${esc(r.rank_code)}"></i>${esc(r.rank)}`;
      $(".card__entity", node).textContent = r.entity_type;
      $(".card__catch", node).textContent = r.catchphrase || "";
      $(".card__stats", node).innerHTML = kpi("受注", r.orders) + kpi("良い評価", r.good_reviews, "good") + kpi("悪い評価", r.bad_reviews, "bad") + kpi("完了率", r.completion_rate, "", "%");
      const tags = r.categories_list.slice(0, 3).map(t => `<span class="tag">${esc(t)}</span>`);
      if (r.categories_list.length > 3) tags.push(`<span class="tag tag--more">+${r.categories_list.length - 3}</span>`);
      $(".card__tags", node).innerHTML = tags.join("");
      $(".card__foot", node).innerHTML = `<span>最終ログイン <b>${esc(r.last_login_text || "不明")}</b></span><span>登録 <b>${esc(r.registered_date || "不明")}</b>${r.registered_days_ago != null ? ` (${r.registered_days_ago}日前)` : ""}</span>`;
      frag.appendChild(node);
    });
    const list = $("#cards"); list.innerHTML = ""; list.appendChild(frag);
    renderPager(pages);
  }
  const kpi = (label, v, mod = "", unit = "") => `<div class="kpi ${mod ? "kpi--" + mod : ""}"><b>${v == null ? "–" : v.toLocaleString() + unit}</b><span>${label}</span></div>`;
  const loginDotClass = m => m == null ? "" : m <= 1440 ? "on" : m <= 10080 ? "recent" : "";
  function avatarFallback(name) {
    const ch = (name || "?").trim().slice(0, 1);
    return "data:image/svg+xml;utf8," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="#0b1020"/><text x="48" y="60" font-size="40" text-anchor="middle" fill="#dcb66c" font-family="serif">${ch}</text></svg>`);
  }

  function renderPager(pages) {
    const el = $("#pager");
    if (pages <= 1) { el.innerHTML = ""; return; }
    const btn = (p, label = p, cls = "") => `<button class="btn btn--sm ${cls} ${p === page ? "is-current" : ""}" data-page="${p}">${label}</button>`;
    let items = [];
    const win = new Set([1, pages, page, page - 1, page + 1, page - 2, page + 2].filter(p => p >= 1 && p <= pages));
    let last = 0;
    for (const p of [...win].sort((a, b) => a - b)) { if (p - last > 1) items.push(`<span class="label">…</span>`); items.push(btn(p)); last = p; }
    el.innerHTML = (page > 1 ? btn(page - 1, "‹ 前へ", "btn--ghost") : "") + items.join("") + (page < pages ? btn(page + 1, "次へ ›", "btn--ghost") : "");
  }

  // ------------------------------------------------------------ stats ----
  function renderStats() {
    const n = ROWS.length;
    const tiles = [
      ["掲載ランサー", n, () => {}],
      ["現在対応可能", ROWS.filter(r => r.availability_label === "対応可能").length, () => { facetSelections.availability = new Set(["対応可能"]); }],
      ["認定ランサー", ROWS.filter(r => r.rank === "認定ランサー").length, () => { facetSelections.rank = new Set(["認定ランサー"]); }],
      ["法人", ROWS.filter(r => r.entity_type === "法人").length, () => { facetSelections.entity = new Set(["法人"]); }],
      ["30日以内に登録", ROWS.filter(r => r.registered_days_ago != null && r.registered_days_ago < 30).length, () => { $('input[name="regpreset"][value="0-29"]').checked = true; }],
    ];
    $("#stats").innerHTML = tiles.map(([k, v], i) => `<div class="stat glass" data-stat="${i}" style="animation-delay:${180 + i * 70}ms"><dt>${k}</dt><dd><span class="gold-text">${v.toLocaleString()}</span><small>人</small></dd></div>`).join("");
    $("#stats").onclick = e => { const t = e.target.closest("[data-stat]"); if (!t) return; resetAll(false); tiles[+t.dataset.stat][2](); apply(); $("#cards").scrollIntoView({ behavior: "smooth", block: "start" }); };
  }

  // ------------------------------------------------------------ modal ----
  function openModal(username) {
    const r = ROWS.find(x => x.username === username); if (!r) return;
    const isOn = checked.has(r.username);
    const dl = pairs => `<dl class="m-dl">${pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>`;
    const tagList = (list, proven = []) => list.length ? `<div class="m-tags">${list.map(t => `<span class="tag ${proven.includes(t) ? "proven" : ""}">${esc(t)}</span>`).join("")}</div>` : `<span class="label">登録なし</span>`;
    $("#modalBody").innerHTML = `
      <div class="m-head">
        <div class="avatar"><img src="${esc(r.avatar_url)}" alt="" onerror="this.onerror=null;this.src='${avatarFallback(r.display_name)}'"><span class="avatar__dot ${loginDotClass(r.last_login_minutes)}"></span></div>
        <div style="min-width:0;flex:1">
          <h2 class="m-title ${isOn ? "is-checked" : ""}" id="mTitle"><span class="gold-text">${esc(r.display_name)}</span><span class="m-check" title="✔マーク付き">✔</span></h2>
          <p class="m-user">@${esc(r.username)} ・ <a href="${esc(r.profile_url)}" target="_blank" rel="noopener">Lancers のプロフィールを開く ↗</a></p>
          <div class="m-meta">
            <span class="tag"><i class="rank-ic rank--${esc(r.rank_code)}" style="vertical-align:-3px;margin-right:4px"></i>${esc(r.rank)}</span>
            <span class="tag">${esc(r.entity_type)}</span>
            ${r.job_category ? `<span class="tag">${esc(r.job_category)}</span>` : ""}
            ${r.prefecture ? `<span class="tag">${esc(r.prefecture)}</span>` : ""}
            ${r.badges_list.map(b => `<span class="tag" style="border-color:var(--gold)">${esc(b)}</span>`).join("")}
          </div>
        </div>
      </div>
      ${r.catchphrase ? `<p class="m-catch">${esc(r.catchphrase)}</p>` : ""}
      <div class="m-mark glass">
        <span class="m-mark__label">✔マーク</span>
        <div class="chips">
          <label class="chip"><input type="radio" name="mark" value="on" ${isOn ? "checked" : ""}><span>✔ マークを付ける</span></label>
          <label class="chip"><input type="radio" name="mark" value="off" ${!isOn ? "checked" : ""}><span>マークを外す</span></label>
        </div>
        <span class="label">状態はこのブラウザに保存され、再読み込みしても保持されます</span>
      </div>
      <div class="m-grid">
        ${kpi("受注数（実績数）", r.orders)}${kpi("良い評価", r.good_reviews, "good")}${kpi("悪い評価", r.bad_reviews, "bad")}
        ${kpi("完了率", r.completion_rate, "", "%")}${kpi("リピーター", r.repeaters)}${kpi("タスク数", r.tasks)}
        ${kpi("タスク承認率", r.task_approval_rate, "", "%")}${kpi("外部実績", r.external_achievements)}${kpi("24h返信率", r.reply_rate_24h, "", "%")}
      </div>
      <div class="m-section"><h3>基本情報</h3>${dl([
        ["表示名", esc(r.display_name)], ["ユーザー名", esc(r.username)],
        ["プロフィールURL", `<a href="${esc(r.profile_url)}" target="_blank" rel="noopener">${esc(r.profile_url)}</a>`],
        ["アバター", `<a href="${esc(r.avatar_url)}" target="_blank" rel="noopener">${esc(r.avatar_url || "なし")}</a>`],
        ["ランク", esc(r.rank)], ["法人 / 個人", esc(r.entity_type)], ["職種", esc(r.job_category || "—")], ["都道府県", esc(r.prefecture || "—")],
        ["最終ログイン", esc(r.last_login_text || "不明")], ["稼働状況", esc(r.availability || "—")],
        ["登録日", r.registered_date ? `${esc(r.registered_date)}（${r.registered_days_ago} 日前）` : "不明"],
        ["稼働単価", r.rates.length ? r.rates.map(x => `${esc(x.label)} ${x.value != null ? x.value.toLocaleString() + " 円/時" : ""}`).join("<br>") : "—"],
        ["データ取得日時", esc(r.scraped_at || "—")],
      ])}</div>
      <div class="m-section"><h3>認証・対応</h3><div class="m-flags">${FLAGS.map(([k, l]) => `<span class="flag ${r[k] === "1" ? "on" : ""}">${r[k] === "1" ? "✓ " : ""}${l}</span>`).join("")}</div></div>
      <div class="m-section"><h3>得意なカテゴリ <small class="label">（✓ = 実績あり）</small></h3>${tagList(r.categories_list, r.categories_proven_list)}</div>
      <div class="m-section"><h3>得意な業種</h3>${tagList(r.industries_list, r.industries_proven_list)}</div>
      <div class="m-section"><h3>スキル</h3>${tagList(r.skills_raw_list)}</div>`;
    $$('#modalBody input[name="mark"]').forEach(inp => inp.addEventListener("change", () => setChecked(r.username, inp.value === "on")));
    const m = $("#modal"); m.hidden = false; document.body.style.overflow = "hidden";
    $(".modal__panel").scrollTop = 0;
    $(".modal__close").focus();
  }
  function closeModal() { $("#modal").hidden = true; document.body.style.overflow = ""; }

  // ------------------------------------------------------------ check ----
  function loadChecked() {
    try { return new Set(JSON.parse(localStorage.getItem(LS_CHECK) || "[]")); } catch (e) { return new Set(); }
  }
  function setChecked(username, on) {
    if (on) checked.add(username); else checked.delete(username);
    try { localStorage.setItem(LS_CHECK, JSON.stringify([...checked])); } catch (e) { toast("保存できませんでした（ブラウザの設定を確認してください）"); }
    $("#mTitle")?.classList.toggle("is-checked", on);
    $$(`.card[data-user="${CSS.escape(username)}"]`).forEach(c => c.classList.toggle("is-checked", on));
    const chk = ($('input[name="check"]:checked') || {}).value;
    if (chk) apply(false); else renderFacets(currentCriteria());
    toast(on ? "✔ マークを付けました" : "✔ マークを外しました");
  }

  // ------------------------------------------------------- url state ----
  function writeHash(c) {
    const p = new URLSearchParams();
    if (c.q) p.set("q", c.q); if (c.qt !== "all") p.set("qt", c.qt);
    if (c.check) p.set("check", c.check);
    const preset = ($('input[name="regpreset"]:checked') || {}).value; if (preset) p.set("reg", preset);
    if ($("#reg_min").value) p.set("regmin", $("#reg_min").value); if ($("#reg_max").value) p.set("regmax", $("#reg_max").value);
    if ($("#reg_from").value) p.set("regfrom", $("#reg_from").value); if ($("#reg_to").value) p.set("regto", $("#reg_to").value);
    const lp = ($('input[name="loginpreset"]:checked') || {}).value; if (lp) p.set("login", lp);
    if ($("#login_max_days").value) p.set("logindays", $("#login_max_days").value);
    for (const f in c.nums) p.set("n_" + f, c.nums[f].map(v => v ?? "").join(","));
    for (const id in facetSelections) if (facetSelections[id].size) p.set("f_" + id, [...facetSelections[id]].join("|"));
    for (const id of ["categories", "industries", "skills"]) if (c.mode[id] === "and") p.set("m_" + id, "and");
    for (const id of ["categories", "industries"]) if (c.proven[id]) p.set("p_" + id, "1");
    if ($("#sort").value !== "registered_desc") p.set("sort", $("#sort").value);
    if (page > 1) p.set("page", page);
    const h = p.toString();
    history.replaceState(null, "", h ? "#" + h : location.pathname + location.search);
  }
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    if (!p.toString()) return;
    $("#q").value = p.get("q") || "";
    setRadio("qt", p.get("qt") || "all"); setRadio("check", p.get("check") || "");
    setRadio("regpreset", p.get("reg") || ""); $("#reg_min").value = p.get("regmin") || ""; $("#reg_max").value = p.get("regmax") || "";
    $("#reg_from").value = p.get("regfrom") || ""; $("#reg_to").value = p.get("regto") || "";
    setRadio("loginpreset", p.get("login") || ""); $("#login_max_days").value = p.get("logindays") || "";
    for (const [k, v] of p) {
      if (k.startsWith("n_")) { const [mn, mx] = v.split(","); const f = k.slice(2); const i = $(`#f_numbers input[data-num="${f}"][data-side="min"]`), j = $(`#f_numbers input[data-num="${f}"][data-side="max"]`); if (i) i.value = mn; if (j) j.value = mx; }
      if (k.startsWith("f_") && facetSelections[k.slice(2)]) facetSelections[k.slice(2)] = new Set(v.split("|").filter(Boolean));
      if (k.startsWith("m_")) setRadio("mode_" + k.slice(2), v);
      if (k.startsWith("p_")) { const el = $("#proven_" + k.slice(2)); if (el) el.checked = v === "1"; }
    }
    if (p.get("sort")) $("#sort").value = p.get("sort");
    page = +p.get("page") || 1;
  }
  const setRadio = (name, val) => { const el = $(`input[name="${name}"][value="${CSS.escape(val)}"]`); if (el) el.checked = true; };

  function resetAll(doApply = true) {
    $("#q").value = ""; setRadio("qt", "all"); setRadio("check", ""); setRadio("regpreset", ""); setRadio("loginpreset", "");
    ["reg_min", "reg_max", "reg_from", "reg_to", "login_max_days"].forEach(id => $("#" + id).value = "");
    $$("#f_numbers input").forEach(i => i.value = "");
    for (const id in facetSelections) facetSelections[id] = new Set();
    ["categories", "industries", "skills"].forEach(id => setRadio("mode_" + id, "or"));
    $("#proven_categories").checked = false; $("#proven_industries").checked = false;
    $$(".facet-search").forEach(i => i.value = ""); Object.keys(facetQuery).forEach(k => delete facetQuery[k]);
    if (doApply) apply();
  }

  // ----------------------------------------------------------- export ----
  function exportCSV() {
    if (!FILTERED.length) return toast("書き出す行がありません");
    const cols = ["username", "display_name", "profile_url", "avatar_url", "rank", "entity_type", "job_category", "prefecture", "orders", "tasks", "good_reviews", "bad_reviews", "completion_rate", "repeaters", "last_login_text", "availability", "registered_date", "registered_days_ago", "identity_verified", "nda_verified", "phone_verified", "lancers_check", "invoice_ready", "video_meeting", "badges", "categories", "industries", "skills", "hourly_rate", "reply_rate_24h", "catchphrase"];
    const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [cols.concat("checked").map(q).join(",")].concat(FILTERED.map(r => cols.map(c => q(r[c])).concat(checked.has(r.username) ? "1" : "0").join(",")));
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `lancers_filtered_${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ------------------------------------------------------------ utils ----
  const esc = s => String(s ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  let toastEl, toastTimer;
  function toast(msg) {
    if (!toastEl) { toastEl = document.createElement("div"); toastEl.className = "toast"; document.body.appendChild(toastEl); }
    toastEl.textContent = msg; toastEl.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1800);
  }

  // ------------------------------------------------------------ events ----
  function bind() {
    $("#btnSearch").onclick = () => apply();
    $("#q").addEventListener("keydown", e => { if (e.key === "Enter") apply(); });
    $("#q").addEventListener("input", scheduleApply);
    $("#sort").onchange = () => apply(false);
    $("#btnReset").onclick = () => resetAll();
    $("#btnExport").onclick = exportCSV;
    $("#btnCopyLink").onclick = async () => { try { await navigator.clipboard.writeText(location.href); toast("検索リンクをコピーしました"); } catch (e) { prompt("検索リンク", location.href); } };
    $("#btnSidebar").onclick = () => $("#sidebar").classList.toggle("is-open");
    $("#sidebar").addEventListener("change", e => {
      const t = e.target;
      if (t.dataset.facet) { const set = facetSelections[t.dataset.facet]; t.checked ? set.add(t.value) : set.delete(t.value); }
      apply();
    });
    $("#sidebar").addEventListener("input", e => {
      const t = e.target;
      if (t.classList.contains("facet-search")) { facetQuery[t.dataset.facetSearch.slice(2)] = t.value; renderFacets(currentCriteria()); return; }
      if (t.type === "number" || t.type === "date") {
        if (t.id === "reg_min" || t.id === "reg_max") setRadio("regpreset", "");
        if (t.id === "login_max_days") setRadio("loginpreset", "");
        scheduleApply();
      }
    });
    $("#sidebar").addEventListener("click", e => {
      const b = e.target.closest("[data-more]"); if (!b) return;
      facetShowAll[b.dataset.more] = !facetShowAll[b.dataset.more]; renderFacets(currentCriteria());
    });
    $("#qTargets").addEventListener("change", () => apply());
    $("#activeFilters").addEventListener("click", e => { const b = e.target.closest("[data-clear]"); if (!b) return; $("#activeFilters")._chips[+b.dataset.clear].clear(); apply(); });
    $("#cards").addEventListener("click", e => { const c = e.target.closest(".card"); if (c) openModal(c.dataset.user); });
    $("#pager").addEventListener("click", e => { const b = e.target.closest("[data-page]"); if (!b) return; page = +b.dataset.page; renderCards(); writeHash(currentCriteria()); $("#cards").scrollIntoView({ behavior: "smooth", block: "start" }); });
    $("#modal").addEventListener("click", e => { if (e.target.closest("[data-close]")) closeModal(); });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("#modal").hidden) closeModal(); });
    document.addEventListener("click", e => { if (window.innerWidth <= 960 && !e.target.closest("#sidebar") && !e.target.closest("#btnSidebar")) $("#sidebar").classList.remove("is-open"); });
  }

  // -------------------------------------------------------------- init ----
  async function init() {
    $("#cards").innerHTML = `<li class="loading">データを読み込んでいます…</li>`;
    try {
      const { rows, url, modified } = await loadData();
      ROWS = rows.map(enrich);
      const stamp = ROWS.reduce((m, r) => (r.scraped_at > m ? r.scraped_at : m), "") || (modified ? new Date(modified).toLocaleString("ja-JP") : "");
      $("#dataStamp").textContent = `${ROWS.length.toLocaleString()} 人 ・ ${stamp ? stamp.slice(0, 16) : url}`;
      $("#footStamp").textContent = stamp ? stamp.slice(0, 10) : "";
      renderStats();
      bind();
      readHash();
      apply(false);
    } catch (err) {
      $("#cards").innerHTML = `<li class="loading">読み込みに失敗しました: ${esc(err.message)}<br><small>python3 serve.py でローカルサーバーを起動して開いてください。</small></li>`;
    }
  }
  init();
})();
