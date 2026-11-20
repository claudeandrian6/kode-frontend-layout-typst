/* IMRECS Journal Layout Engine — PDF.js + Multi-Segment Interactive Overlay + Local Draft (v42) */
"use strict";

if (window.pdfjsLib) {
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

const META_IDS = [
  ["judul", "m-judul", "meta-judul"],
  ["penulis", "m-penulis", "meta-penulis"],
  ["afiliasi", "m-afiliasi", "meta-afiliasi"],
  ["riwayat_diterima", "m-riwayat-diterima", "meta-riwayat-diterima"],
  ["riwayat_disetujui", "m-riwayat-disetujui", "meta-riwayat-disetujui"],
  ["riwayat_terbit", "m-riwayat-terbit", "meta-riwayat-terbit"],
  ["email", "m-email", "meta-email"],
  ["kata_kunci", "m-kata-kunci", "meta-kata-kunci"],
  ["abstrak", "m-abstrak", "meta-abstrak"],
  ["sitasi", "m-sitasi", "meta-sitasi"]
];

function emptyDraft() {
  return { edits: {}, moves: [], deletes: [], splits: [], crops: {}, kaki_naik: {}, header_naik: {} };
}

window.EditorState = {
  articleId: null, versi: null, halaman: 0, halamanAwal: 1,
  blocks: [], layoutSegments: [], pageTextLines: {}, _segCache: null, terbitan: {},
  kakiNaikMap: {}, headerNaikMap: {}, masalah: [], statusQa: "", riwayatCount: 0, redoCount: 0,
  selectedId: null, selectedIds: [], activePage: 1, zoom: 100, showFrames: true, showGrid: false, previewMode: false,
  freezeLayout: false, _freezeExplicitlyOff: false, _freezeUnlockedIds: {}, isCutMode: false,
  pointer: null, cropDrag: null, cropTarget: null, pdfDoc: null, serverBusy: false,
  _localSplitTexts: {}, _localSplitStyles: {}, _localSplitNewIds: {},
  draft: emptyDraft()
};

let _renderToken = 0;
let _buildPollTimer = null;
let _autoSaveTimer = null;
let _activeSavePromise = null;
const AUTO_SAVE_DELAY_MS = 1600;

// ==================== 1. UI HELPERS, AUTO-RENDER & DRAFT MANAGER ====================
function showToast(msg, dur = 2800) {
  let c = document.getElementById("toast-container");
  if (!c) { c = document.createElement("div"); c.id = "toast-container"; document.body?.appendChild(c); }
  const el = document.createElement("div");
  el.className = "toast-msg";
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; setTimeout(() => el.remove(), 260); }, dur);
}

function setServerLoading(aktif, pesan = "⏳ Memproses di Server...") {
  window.EditorState.serverBusy = !!aktif;
  const ov = document.getElementById("server-loading-overlay");
  if (ov) {
    ov.hidden = !aktif;
    const card = ov.querySelector(".server-loading-card");
    if (card && pesan) card.textContent = pesan;
  }
}

function setAutoRenderIndicator(aktif, pesan = "Merender ulang PDF...") {
  window.EditorState.serverBusy = !!aktif;
  let pill = document.getElementById("auto-render-indicator");
  if (!pill && document.body) {
    pill = document.createElement("div");
    pill.id = "auto-render-indicator";
    pill.className = "auto-render-pill";
    pill.hidden = true;
    pill.innerHTML = `<span class="auto-render-spinner"></span><span class="auto-render-text"></span>`;
    document.body.appendChild(pill);
  }
  if (pill) {
    pill.hidden = !aktif;
    const txt = pill.querySelector(".auto-render-text");
    if (txt && pesan) txt.textContent = pesan;
  }
}

function cancelAutoSave() {
  if (_autoSaveTimer) {
    clearTimeout(_autoSaveTimer);
    _autoSaveTimer = null;
  }
}

function scheduleAutoSave(delay = AUTO_SAVE_DELAY_MS) {
  cancelAutoSave();
  const S = window.EditorState;
  if (!S.articleId || draftChangeCount() === 0) {
    refreshDraftUi();
    return;
  }
  setDraftStatus("menunggu", `⏱ Auto-render (${draftChangeCount()})...`);
  _autoSaveTimer = setTimeout(() => {
    _autoSaveTimer = null;
    if (!S.articleId || draftChangeCount() === 0) {
      refreshDraftUi();
      return;
    }
    if (S.pointer || S.cropDrag) {
      scheduleAutoSave(delay);
      return;
    }
    if (S.serverBusy) {
      scheduleAutoSave(900);
      return;
    }
    saveWorkspaceToServer({ background: true });
  }, delay);
}

function draftChangeCount() {
  const d = window.EditorState.draft;
  return Object.keys(d.edits).length + d.moves.length + d.deletes.length +
         (Array.isArray(d.splits) ? d.splits.length : 0) +
         Object.keys(d.crops).length + Object.keys(d.kaki_naik).length +
         Object.keys(d.header_naik).length;
}

function persistLocalDraft() {
  const S = window.EditorState;
  if (!S.articleId) return;
  const n = draftChangeCount();
  try {
    if (n > 0) localStorage.setItem("imrecs_draft_" + S.articleId, JSON.stringify(S.draft));
    else localStorage.removeItem("imrecs_draft_" + S.articleId);
  } catch (_) {}
  refreshDraftUi();
}

function restoreLocalDraft(articleId) {
  try {
    const raw = localStorage.getItem("imrecs_draft_" + articleId);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        edits: parsed.edits || {},
        moves: Array.isArray(parsed.moves) ? parsed.moves : [],
        deletes: Array.isArray(parsed.deletes) ? parsed.deletes : [],
        splits: Array.isArray(parsed.splits) ? parsed.splits : [],
        crops: parsed.crops || {},
        kaki_naik: parsed.kaki_naik || {},
        header_naik: parsed.header_naik || {}
      };
    }
  } catch (_) {}
  return emptyDraft();
}

function setDraftStatus(keadaan, teks) {
  const el = document.getElementById("status-draft");
  if (!el) return;
  if (keadaan) el.setAttribute("data-keadaan", keadaan);
  else el.removeAttribute("data-keadaan");
  el.textContent = teks;
}

function refreshDraftUi() {
  const n = draftChangeCount();
  const btnSave = document.getElementById("btn-simpan-server");
  const btnReset = document.getElementById("btn-reset-draft");
  if (n > 0) {
    setDraftStatus("kotor", `Draft Lokal (${n})`);
    btnSave?.classList.add("pulse-dirty");
    if (btnReset) btnReset.hidden = false;
  } else {
    setDraftStatus("", "Tersimpan");
    btnSave?.classList.remove("pulse-dirty");
    if (btnReset) btnReset.hidden = true;
  }
}

function getEffectiveBlock(bid) {
  const S = window.EditorState;
  const base = S.blocks.find(b => b.id === bid);
  if (!base) return null;
  const ed = S.draft.edits[bid];
  const splitStyle = S._localSplitStyles?.[bid];
  const mergedStyle = Object.assign({}, base.style || {}, splitStyle || {}, ed?.style || {});
  const dc = S.draft.crops[bid];
  if (dc) {
    mergedStyle.crop = dc.reset ? null : { left: dc.left, top: dc.top, right: dc.right, bottom: dc.bottom };
  }
  const splitText = S._localSplitTexts?.[bid];
  return Object.assign({}, base, {
    text: ed?.text !== undefined ? ed.text : (splitText !== undefined ? splitText : base.text),
    style: mergedStyle
  });
}

function recordEditDraft(bid, patch) {
  const S = window.EditorState;
  if (!bid) return;
  const prev = S.draft.edits[bid] || { block_id: bid };
  const next = Object.assign({}, prev, { block_id: bid });
  if (patch.text !== undefined) next.text = patch.text;
  if (patch.caption !== undefined) next.caption = patch.caption;
  if (patch.style) next.style = Object.assign({}, prev.style || {}, patch.style);
  S.draft.edits[bid] = next;
  persistLocalDraft();
  markModifiedBoxesOnDom();
  renderObjectNavigator();
}

function apiUrl(aksi, params = {}) {
  const url = new URL("api.php", window.location.href);
  url.searchParams.set("aksi", aksi);
  Object.entries(params).forEach(([k, v]) => { if (v != null) url.searchParams.set(k, String(v)); });
  return url.toString();
}

async function apiFetch(aksi, params = {}, bodyObj = null) {
  const opts = { method: bodyObj !== null ? "POST" : "GET" };
  if (bodyObj !== null) {
    if (bodyObj instanceof FormData) {
      opts.body = bodyObj;
    } else {
      const fd = new FormData();
      Object.entries(bodyObj).forEach(([k, v]) => {
        if (v === undefined || v === null) return;
        fd.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
      });
      opts.body = fd;
    }
  }
  const res = await fetch(apiUrl(aksi, params), opts);
  if (res.status === 401) {
    document.body.className = "belum";
    document.getElementById("layar-masuk")?.removeAttribute("hidden");
    document.getElementById("aplikasi")?.setAttribute("hidden", "");
    throw new Error("Sesi berakhir. Silakan masuk kembali.");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || (data && data.ok === false)) {
    throw new Error(data?.galat || `Permintaan gagal (${res.status})`);
  }
  return data;
}

function updateQaStatus(qaObj, riwayatObj) {
  const S = window.EditorState;
  const masalah = qaObj?.masalah || [];
  S.masalah = masalah;
  const statusStr = (qaObj?.status || (masalah.length === 0 ? "LULUS" : "DITAHAN")).toUpperCase();
  const lulus = statusStr === "LULUS" && masalah.length === 0;
  S.statusQa = lulus ? "lulus" : "ditahan";

  const qaEl = document.getElementById("qa-status");
  if (qaEl) {
    qaEl.textContent = lulus ? "QA: LULUS" : `QA: DITAHAN (${masalah.length})`;
    qaEl.style.cssText = lulus
      ? "color:var(--hijau);border-color:#86efac;background:#dcfce7;"
      : "color:var(--merah);border-color:#fca5a5;background:#fee2e2;";
  }
  const box = document.getElementById("qa-masalah-box");
  if (box) {
    box.style.color = lulus ? "var(--hijau)" : "var(--merah)";
    if (lulus) {
      box.innerHTML = "✅ Tata letak <b>LULUS</b> seluruh aturan ketat jurnal.";
    } else {
      box.innerHTML = "<strong>Daftar Pelanggaran QA (klik untuk lompat):</strong><ul style='padding-left:16px;margin-top:5px'>" +
        masalah.map(m => {
          const teks = typeof m === "object" ? (m.teks || m.pesan || JSON.stringify(m)) : String(m);
          const hal = typeof m === "object" && m.hal ? m.hal : 1;
          return `<li class="qa-jump-item" data-hal="${hal}">${teks.replace(/</g, "&lt;")}</li>`;
        }).join("") + "</ul>";
      box.querySelectorAll(".qa-jump-item").forEach(li => {
        li.onclick = () => scrollToPage(parseInt(li.dataset.hal, 10) || 1);
      });
    }
  }
  if (riwayatObj) {
    S.riwayatCount = riwayatObj.batal ?? 0;
    S.redoCount = riwayatObj.ulang ?? 0;
    const uBtn = document.getElementById("btn-undo"), rBtn = document.getElementById("btn-redo");
    if (uBtn) uBtn.disabled = !(S.riwayatCount > 0);
    if (rBtn) rBtn.disabled = !(S.redoCount > 0);
  }
}

// ==================== 2. DAFTAR ARTIKEL, HAPUS ARTIKEL & WORKSPACE ====================
async function loadArticleList(preferredId = null) {
  try {
    const res = await apiFetch("daftar");
    const ul = document.getElementById("daftar-artikel");
    if (ul && Array.isArray(res.artikel)) {
      if (res.artikel.length === 0) {
        ul.innerHTML = `<li style="cursor:default;color:var(--redup)">Belum ada artikel. Klik + Build Word.</li>`;
      } else {
        ul.innerHTML = res.artikel.map(a => `
          <li data-id="${a.nama}" class="${window.EditorState.articleId === a.nama ? "aktif" : ""}">
            <div class="art-meta-wrap">
              <div class="art-title" title="${a.nama}">${a.nama}</div>
              <small>${a.status ? a.status + " • " : ""}${new Date(a.diubah * 1000).toLocaleDateString("id-ID")}</small>
            </div>
            <button type="button" class="btn-del-art" data-del="${a.nama}" title="Hapus artikel ${a.nama}">🗑️</button>
          </li>`).join("");
        ul.querySelectorAll("li[data-id]").forEach(li => {
          li.onclick = e => {
            if (e.target.closest(".btn-del-art")) return;
            loadArticle(li.dataset.id);
          };
        });
        ul.querySelectorAll(".btn-del-art").forEach(btn => {
          btn.onclick = e => {
            e.stopPropagation();
            confirmDeleteArticle(btn.dataset.del);
          };
        });
      }
      const target = preferredId || window.EditorState.articleId || (res.artikel[0]?.nama ?? null);
      if (target && res.artikel.some(x => x.nama === target) && window.EditorState.articleId !== target) {
        loadArticle(target);
      }
    }
    const pj = document.getElementById("input-jurnal-baru");
    if (pj && Array.isArray(res.jurnal) && res.jurnal.length > 0) {
      pj.innerHTML = res.jurnal.map(j => `<option value="${j}">${j}</option>`).join("");
    }
  } catch (err) {
    showToast("Gagal memuat daftar artikel: " + err.message);
  }
}

async function confirmDeleteArticle(nama) {
  if (!nama) return;
  if (!window.confirm(`Hapus artikel "${nama}"? Folder kerja akan dipindahkan ke arsip _terhapus.`)) return;
  cancelAutoSave();
  setServerLoading(true, `⏳ Menghapus artikel ${nama}...`);
  try {
    await apiFetch("delete_article", {}, { article_id: nama });
    try { localStorage.removeItem("imrecs_draft_" + nama); } catch (_) {}
    showToast(`Artikel "${nama}" berhasil dihapus`);
    if (window.EditorState.articleId === nama) {
      window.EditorState.articleId = null;
      window.EditorState.selectedId = null;
      window.EditorState.selectedIds = [];
      window.EditorState.blocks = [];
      window.EditorState.layoutSegments = [];
      window.EditorState.pageTextLines = {};
      window.EditorState._segCache = null;
      document.getElementById("kanvas-pdf").innerHTML = `<div class="empty-state">Artikel dihapus. Pilih artikel lain atau bangun naskah baru.</div>`;
      document.getElementById("daftar-objek").innerHTML = "";
      document.getElementById("judul-artikel").textContent = "Pilih Artikel";
    }
    await loadArticleList();
  } catch (err) {
    showToast("Gagal menghapus artikel: " + err.message);
  } finally {
    setServerLoading(false);
  }
}

async function loadArticle(articleId) {
  if (!articleId) return;
  cancelAutoSave();
  const S = window.EditorState;
  S.articleId = articleId;
  S._freezeExplicitlyOff = false;
  S._freezeUnlockedIds = {};
  S.selectedId = null;
  S.selectedIds = [];
  S.pageTextLines = {};
  S._segCache = null;
  S._localSplitTexts = {};
  S._localSplitStyles = {};
  S._localSplitNewIds = {};
  S.draft = restoreLocalDraft(articleId);

  const jEl = document.getElementById("judul-artikel");
  if (jEl) jEl.textContent = articleId;
  document.querySelectorAll("#daftar-artikel li").forEach(li => li.classList.toggle("aktif", li.dataset.id === articleId));

  setServerLoading(true, "⏳ Memuat Workspace & PDF dari Server...");
  setDraftStatus("menyimpan", "Memuat...");
  try {
    const ws = await apiFetch("get_workspace", { artikel: articleId });
    await applyWorkspaceState(ws, true);
    refreshDraftUi();
    // Jika cache QA belum tersedia di get_workspace, ambil di latar belakang
    if (!ws.qa) {
      apiFetch("get_qa", { artikel: articleId }).then(qRes => {
        if (qRes?.qa && window.EditorState.articleId === articleId) {
          if (qRes.qa.kaki_naik) syncKakiNaikFromMap(qRes.qa.kaki_naik);
          updateQaStatus(qRes.qa, null);
        }
      }).catch(() => {});
    }
  } catch (err) {
    console.error("loadArticle error:", err);
    showToast("Gagal memuat artikel: " + err.message);
    setDraftStatus("kotor", "Gagal");
  } finally {
    setServerLoading(false);
  }
}

function _parseBarisMap(rawMap) {
  const res = {};
  if (rawMap && typeof rawMap === "object") {
    Object.entries(rawMap).forEach(([h, v]) => {
      const num = Number(v);
      if (!Number.isFinite(num)) return;
      const baris = Math.abs(num) > 2 ? Math.round(num / 11) : Math.round(num);
      res[parseInt(h, 10)] = Math.max(-2, Math.min(2, baris));
    });
  }
  return res;
}

function syncKakiNaikFromMap(kakiMap) {
  const S = window.EditorState;
  S.kakiNaikMap = _parseBarisMap(kakiMap);
}

function syncHeaderNaikFromMap(headerMap) {
  const S = window.EditorState;
  S.headerNaikMap = _parseBarisMap(headerMap);
}

async function applyWorkspaceState(ws, renderPdf = true) {
  const S = window.EditorState;
  S.versi = ws.versi || String(Date.now());
  S.halaman = ws.halaman || ws.layout_map?.halaman || 0;
  S.halamanAwal = ws.halaman_awal || ws.layout_map?.halaman_awal || 1;
  S.blocks = Array.isArray(ws.blocks) ? ws.blocks : [];
  S.layoutSegments = Array.isArray(ws.layout_map?.blocks) ? ws.layout_map.blocks : [];
  S._segCache = null;
  S._localSplitTexts = {};
  S._localSplitStyles = {};
  S._localSplitNewIds = {};
  if (Array.isArray(S.draft?.splits) && S.draft.splits.length > 0) {
    replayLocalSplitsFromDraft();
  }
  const hasFreezeState = (Array.isArray(S.draft?.splits) && S.draft.splits.some(sp => sp?.frozen)) ||
    (S.blocks || []).some(b => {
      const eff = getEffectiveBlock(b.id);
      return Boolean(eff?.style?.frozen || eff?.style?.unlocked_in_freeze);
    });
  if (hasFreezeState && !S._freezeExplicitlyOff && !S.freezeLayout) {
    S._freezeUnlockedIds = {};
    (S.blocks || []).forEach(b => {
      const eff = getEffectiveBlock(b.id);
      if (eff?.style?.unlocked_in_freeze) S._freezeUnlockedIds[b.id] = true;
    });
    setFreezeLayoutUi(true);
  }
  S.terbitan = ws.terbitan || {};
  if (ws.kaki_naik || ws.qa?.kaki_naik) {
    syncKakiNaikFromMap(ws.kaki_naik || ws.qa?.kaki_naik);
  }
  syncHeaderNaikFromMap(ws.header_naik || {});
  syncHeaderFooterControls(S.activePage || 1);
  updateQaStatus(ws.qa || { status: ws.status || "LULUS", masalah: [] }, ws.riwayat);
  populateMoveTargetSelect();
  renderObjectNavigator();
  if (renderPdf) {
    await renderPdfFromServer(S.articleId, S.versi);
    renderObjectNavigator();
  } else {
    rebuildAllOverlays();
  }
}

// ==================== 3. BOUNDING BOX MULTI-SEGMEN PRESISI & OVERLAY PDF.JS ====================
function subtractIntervals(ya, yb, obstacles, minHeight = 9) {
  let parts = [[ya, yb]];
  const sorted = obstacles.slice().sort((a, b) => a[0] - b[0]);
  for (const [oa, ob] of sorted) {
    const next = [];
    for (const [a, b] of parts) {
      if (ob <= a + 0.5 || oa >= b - 0.5) {
        next.push([a, b]);
      } else {
        if (oa - a >= minHeight) next.push([a, oa]);
        if (b - ob >= minHeight) next.push([ob, b]);
      }
    }
    parts = next;
  }
  return parts;
}

async function extractPdfPageTextLines(page, pageNum) {
  const S = window.EditorState;
  try {
    const tc = await page.getTextContent();
    const view = page.view || [0, 0, 595.28, 841.89];
    const pageH = (view[3] - view[1]) || 841.89;
    const rawPage = S.layoutSegments.filter(s => Number(s.page) === Number(pageNum));
    const nonMetaYs = rawPage.filter(s => s.type !== "meta").map(s => Number(s.y)).filter(Number.isFinite);
    const minBodyY = pageNum === 1 ? ((nonMetaYs.length ? Math.min(...nonMetaYs) : 500) - 3) : 100.5;
    const maxBodyY = 764.5;
    const objBoxes = rawPage
      .filter(s => (s.type === "figure" || s.type === "table") && !s.frozen)
      .map(s => ({
        x0: (Number(s.x) || 76.535) - 2,
        y0: (Number(s.y) || 0) - 2,
        x1: (Number(s.x) || 76.535) + (Number(s.width) || 213.6) + 2,
        y1: (Number(s.y) || 0) + (Number(s.height) || 20) + 2
      }));

    const colBuckets = { 1: [], 2: [] };
    for (const it of (tc.items || [])) {
      if (!it.str || !/\S/.test(it.str) || !Array.isArray(it.transform)) continue;
      const tr = it.transform;
      const fs = Math.hypot(tr[2] || 0, tr[3] || 0) || Math.abs(tr[3] || 0) || Number(it.height) || 10;
      const x0 = tr[4] - (view[0] || 0);
      const x1 = x0 + Math.max(2, Number(it.width) || fs);
      const baselineY = pageH - (tr[5] - (view[1] || 0));
      const y0 = baselineY - fs * 0.80;
      const y1 = baselineY + fs * 0.22;
      const yMid = (y0 + y1) / 2;
      if (y0 < minBodyY || yMid > maxBodyY) continue;
      if (objBoxes.some(ob => x1 > ob.x0 + 4 && x0 < ob.x1 - 4 && yMid >= ob.y0 && yMid <= ob.y1)) continue;
      const col = (x0 >= 68 && x0 < 296) ? 1 : ((x0 >= 298 && x0 <= 534) ? 2 : 0);
      if (col === 1 || col === 2) colBuckets[col].push({ top: y0, bottom: y1, base: baselineY });
    }

    const merged = { 1: [], 2: [] };
    for (const col of [1, 2]) {
      const items = colBuckets[col].sort((a, b) => a.base - b.base);
      for (const item of items) {
        const last = merged[col][merged[col].length - 1];
        if (last && Math.abs(item.base - last.base) <= 3.5) {
          last.top = Math.min(last.top, item.top);
          last.bottom = Math.max(last.bottom, item.bottom);
        } else {
          merged[col].push({ top: item.top, bottom: item.bottom, base: item.base });
        }
      }
    }
    S.pageTextLines[pageNum] = merged;
    S._segCache = null;
  } catch (_) {}
}

function getPageHeaderBaseTop(pageNum) {
  const S = window.EditorState;
  const p = Number(pageNum) || 1;
  if (p >= 2) return 102.4;
  const rawPage = S.layoutSegments.filter(s => Number(s.page) === 1);
  const nonMetaYs = rawPage.filter(s => s.type !== "meta").map(s => Number(s.y)).filter(Number.isFinite);
  let curTop = 512.8;
  if (nonMetaYs.length > 0) {
    curTop = Math.min(...nonMetaYs);
  } else {
    const metaBottoms = rawPage.filter(s => s.type === "meta").map(s => (Number(s.y) || 0) + (Number(s.height) || 0));
    if (metaBottoms.length > 0) curTop = Math.max(...metaBottoms) + 6;
  }
  const renderedBaris = Number(S.headerNaikMap[1]) || 0;
  return Math.max(102.4, curTop - (renderedBaris * 11));
}

/**
 * Merekonstruksi kotak multi-segmen presisi dengan membagi halaman menjadi pita 2-kolom
 * di sekitar gambar/tabel penuh (span="page"), memetakan aliran teks berurutan antar jangkar
 * #pm, serta memangkas batas atas/bawah tepat mengikuti baris teks aktual PDF.js.
 */
function getReconstructedSegments() {
  const S = window.EditorState;
  if (S._segCache) return S._segCache;
  const rawAll = Array.isArray(S.layoutSegments) ? S.layoutSegments : [];
  if (rawAll.length === 0) return [];

  const maxPageFromSegs = rawAll.reduce((m, s) => Math.max(m, Number(s.page) || 1), 1);
  const totalPages = Math.max(Number(S.halaman) || 1, maxPageFromSegs);

  // 1. Gabungkan objek non-teks (meta, figure, table) per (page, id, colKey)
  const fixedGroups = new Map();
  const objByPage = new Map();
  for (const seg of rawAll) {
    if (seg.type !== "meta" && seg.type !== "figure" && seg.type !== "table") continue;
    const p = Number(seg.page) || 1;
    const colKey = seg.span === "page" ? 0 : (Number(seg.column) || 0);
    const key = `${p}::${seg.id}::${colKey}`;
    const x1 = Number(seg.x) || 76.535;
    const y1 = Number(seg.y) || 0;
    const w = Math.max(12, Number(seg.width) || (seg.span === "page" ? 442.2 : 213.6));
    const h = Math.max(9, Number(seg.height) || 14);
    if (!fixedGroups.has(key)) {
      fixedGroups.set(key, {
        id: seg.id, type: seg.type, label: seg.label || seg.id, nomor: seg.nomor ?? null,
        page: p, column: colKey, span: seg.span || (colKey === 0 ? "page" : "column"),
        minX: x1, minY: y1, maxX: x1 + w, maxY: y1 + h, segCount: 1,
        frozen: !!seg.frozen, freeze_x: Number(seg.freeze_x) || 0, freeze_y: Number(seg.freeze_y) || 0
      });
    } else {
      const g = fixedGroups.get(key);
      g.minX = Math.min(g.minX, x1);
      g.minY = Math.min(g.minY, y1);
      g.maxX = Math.max(g.maxX, x1 + w);
      g.maxY = Math.max(g.maxY, y1 + h);
      g.segCount++;
      if (seg.frozen) {
        g.frozen = true;
        g.freeze_x = Number(seg.freeze_x) || 0;
        g.freeze_y = Number(seg.freeze_y) || 0;
      }
    }
  }

  const results = [];
  for (const g of fixedGroups.values()) {
    const item = {
      id: g.id, type: g.type, label: g.label, nomor: g.nomor,
      page: g.page, column: g.column, span: g.span,
      x: Number(g.minX.toFixed(2)), y: Number(g.minY.toFixed(2)),
      width: Number((g.maxX - g.minX).toFixed(2)), height: Number((g.maxY - g.minY).toFixed(2)),
      segCount: g.segCount,
      frozen: !!g.frozen, freeze_x: g.freeze_x || 0, freeze_y: g.freeze_y || 0
    };
    results.push(item);
    if (g.type === "figure" || g.type === "table") {
      if (!objByPage.has(g.page)) objByPage.set(g.page, []);
      objByPage.get(g.page).push(item);
    }
  }

  // 2. Bangun slot aliran kolom (pita 2-kolom terurut global: kiri-atas -> kanan-atas -> objek -> kiri-bawah -> kanan-bawah)
  const slots = [];
  for (let p = 1; p <= totalPages; p++) {
    const draftKepala = S.draft.header_naik[p];
    const barisKepala = draftKepala !== undefined ? Number(draftKepala) : (Number(S.headerNaikMap[p]) || 0);
    const bodyTop = getPageHeaderBaseTop(p) + (barisKepala * 11);
    const draftKaki = S.draft.kaki_naik[p];
    const barisKaki = draftKaki !== undefined ? Number(draftKaki) : (Number(S.kakiNaikMap[p]) || 0);
    const bodyBottom = 762.4 - (barisKaki * 11);

    const pageObjs = objByPage.get(p) || [];
    const spanObs = pageObjs
      .filter(o => o.span === "page")
      .map(o => {
        const baseY = o.frozen ? (o.y - (Number(o.freeze_y) || 0)) : o.y;
        return [baseY - 2, baseY + o.height + 2];
      });
    const bands = subtractIntervals(bodyTop, bodyBottom, spanObs, 9);

    bands.forEach(([bandTop, bandBottom], bandIdx) => {
      for (const col of [1, 2]) {
        const colObs = pageObjs
          .filter(o => o.span !== "page" && Number(o.column) === col)
          .map(o => {
            const baseY = o.frozen ? (o.y - (Number(o.freeze_y) || 0)) : o.y;
            return [baseY - 2, baseY + o.height + 2];
          });
        const subSlots = subtractIntervals(bandTop, bandBottom, colObs, 9);
        for (const [sTop, sBottom] of subSlots) {
          slots.push({ idx: slots.length, page: p, band: bandIdx, col, y1: sTop, y2: sBottom });
        }
      }
    });
  }

  const findSlot = (page, col, y) => {
    const cands = slots.filter(s => s.page === page && s.col === col);
    for (const s of cands) {
      if (y >= s.y1 - 6 && y <= s.y2 + 6) return s;
    }
    let best = null, bestDist = Infinity;
    for (const s of cands) {
      const d = Math.min(Math.abs(y - s.y1), Math.abs(y - s.y2));
      if (d < bestDist) { bestDist = d; best = s; }
    }
    return best;
  };

  // 3. Urutkan jangkar awal tiap blok teks dan rekonstruksi segmen lintas kolom/halaman
  // Catatan: Segmen teks frozen tidak dipotong/disnap slot, langsung dipertahankan dari server
  for (const seg of rawAll) {
    if (seg.type === "meta" || seg.type === "figure" || seg.type === "table") continue;
    if (seg.frozen) {
      results.push({
        id: seg.id, type: seg.type || "paragraph", label: seg.label || seg.id,
        nomor: seg.nomor ?? null, page: Number(seg.page) || 1,
        column: Number(seg.column) || 1, span: seg.span || "column",
        x: Number(seg.x) || 76.54, y: Number(seg.y) || 102.4,
        width: Number(seg.width) || 213.6, height: Number(seg.height) || 14,
        segCount: 1, frozen: true,
        freeze_x: Number(seg.freeze_x) || 0, freeze_y: Number(seg.freeze_y) || 0
      });
    }
  }

  const firstSegById = new Map();
  let orderCounter = 0;
  for (const seg of rawAll) {
    if (seg.type === "meta" || seg.type === "figure" || seg.type === "table" || seg.frozen) continue;
    const cur = firstSegById.get(seg.id);
    if (!cur) {
      firstSegById.set(seg.id, { seg, order: orderCounter++, rawMaxSeg: seg });
    } else {
      if ((seg.segment ?? 0) < (cur.seg.segment ?? 0)) cur.seg = seg;
      const curEnd = [Number(cur.rawMaxSeg.page) || 1, Number(cur.rawMaxSeg.column) || 1, (Number(cur.rawMaxSeg.y) || 0) + (Number(cur.rawMaxSeg.height) || 0)];
      const candEnd = [Number(seg.page) || 1, Number(seg.column) || 1, (Number(seg.y) || 0) + (Number(seg.height) || 0)];
      if (candEnd[0] > curEnd[0] || (candEnd[0] === curEnd[0] && (candEnd[1] > curEnd[1] || (candEnd[1] === curEnd[1] && candEnd[2] > curEnd[2])))) {
        cur.rawMaxSeg = seg;
      }
    }
  }

  const anchors = [];
  for (const [bid, info] of firstSegById.entries()) {
    const s0 = info.seg;
    const p = Number(s0.page) || 1;
    const col = Number(s0.column) || ((Number(s0.x) || 76.535) < 290 ? 1 : 2);
    const y = Number(s0.y) || 102.4;
    const sl = findSlot(p, col, y);
    if (sl) anchors.push({ bid, s0, sl, y, order: info.order, rawMaxSeg: info.rawMaxSeg });
  }
  anchors.sort((a, b) => (a.sl.idx - b.sl.idx) || (a.y - b.y) || (a.order - b.order));

  for (let i = 0; i < anchors.length; i++) {
    const cur = anchors[i];
    let endSlotIdx, endY;
    if (i + 1 < anchors.length) {
      endSlotIdx = anchors[i + 1].sl.idx;
      endY = anchors[i + 1].y;
    } else {
      const tailSlots = slots.filter(s => s.page >= cur.sl.page);
      const hasPdfLines = !!S.pageTextLines[cur.sl.page];
      if (hasPdfLines && tailSlots.length > 0) {
        endSlotIdx = tailSlots[tailSlots.length - 1].idx;
        endY = tailSlots[tailSlots.length - 1].y2;
      } else {
        const ms = cur.rawMaxSeg;
        const mp = Number(ms.page) || cur.sl.page;
        const mc = Number(ms.column) || cur.sl.col;
        const my = (Number(ms.y) || cur.y) + Math.max(11, Number(ms.height) || 14);
        const msl = findSlot(mp, mc, my - 2) || cur.sl;
        endSlotIdx = Math.max(cur.sl.idx, msl.idx);
        endY = endSlotIdx === cur.sl.idx ? Math.max(cur.y + 11, my) : my;
      }
    }

    for (let sidx = cur.sl.idx; sidx <= endSlotIdx; sidx++) {
      const sl = slots[sidx];
      if (!sl) continue;
      const ya = sidx === cur.sl.idx ? Math.max(sl.y1 - 2, cur.y) : sl.y1;
      const yb = sidx === endSlotIdx ? Math.min(sl.y2 + 2, endY) : sl.y2;
      if (yb - ya < 4 && sidx !== cur.sl.idx) continue;

      const pageLines = S.pageTextLines[sl.page]?.[sl.col];
      const colX = sl.col === 1 ? 76.54 : 305.14;
      if (Array.isArray(pageLines)) {
        const matched = pageLines.filter(ln => {
          const mid = (ln.top + ln.bottom) / 2;
          return mid >= ya - 2.5 && mid <= yb + 1.0;
        });
        if (matched.length > 0) {
          let ty1 = sidx === cur.sl.idx
            ? Math.max(sl.y1 - 2, Math.min(ya, matched[0].top))
            : Math.max(sl.y1 - 1, matched[0].top - 0.4);
          let ty2 = matched[matched.length - 1].bottom + 0.4;
          if (sidx === endSlotIdx && i + 1 < anchors.length) {
            ty2 = Math.min(ty2, endY - 0.4);
          }
          results.push({
            id: cur.bid, type: cur.s0.type || "paragraph", label: cur.s0.label || cur.bid,
            nomor: cur.s0.nomor ?? null, page: sl.page, column: sl.col, span: "column",
            x: colX, y: Number(ty1.toFixed(2)), width: 213.6,
            height: Number(Math.max(10, ty2 - ty1).toFixed(2)), segCount: 1
          });
        } else if (sidx === cur.sl.idx) {
          results.push({
            id: cur.bid, type: cur.s0.type || "paragraph", label: cur.s0.label || cur.bid,
            nomor: cur.s0.nomor ?? null, page: sl.page, column: sl.col, span: "column",
            x: colX, y: Number(ya.toFixed(2)), width: 213.6,
            height: Number(Math.max(10.5, Math.min(yb - ya, 14)).toFixed(2)), segCount: 1
          });
        }
      } else {
        const fallbackH = Math.max(10.5, yb - ya);
        if (sidx === cur.sl.idx || yb - ya >= 9.5) {
          results.push({
            id: cur.bid, type: cur.s0.type || "paragraph", label: cur.s0.label || cur.bid,
            nomor: cur.s0.nomor ?? null, page: sl.page, column: sl.col, span: "column",
            x: colX, y: Number(ya.toFixed(2)), width: 213.6,
            height: Number(fallbackH.toFixed(2)), segCount: 1
          });
        }
      }
    }
  }

  S._segCache = results;
  return results;
}

function getMergedPageSegments(pageNum) {
  return getReconstructedSegments().filter(seg => Number(seg.page) === Number(pageNum));
}

function getActiveViewportPage() {
  const S = window.EditorState;
  const vp = document.getElementById("viewport-utama");
  const sheets = Array.from(document.querySelectorAll(".pdf-page-sheet"));
  if (!vp || !sheets.length) return S.activePage || 1;
  const vpRect = vp.getBoundingClientRect();
  const vpMidY = vpRect.top + vpRect.height / 2;
  let bestPage = S.activePage || 1;
  let bestScore = Infinity;
  sheets.forEach(sh => {
    const r = sh.getBoundingClientRect();
    const dist = vpMidY < r.top ? (r.top - vpMidY) : (vpMidY > r.bottom ? (vpMidY - r.bottom) : 0);
    const midDist = Math.abs((r.top + r.bottom) / 2 - vpMidY);
    const score = dist * 10000 + midDist;
    if (score < bestScore) {
      bestScore = score;
      bestPage = parseInt(sh.dataset.page, 10) || bestPage;
    }
  });
  return bestPage;
}

function isBlockFrozenLocked(bid) {
  const S = window.EditorState;
  const blk = getEffectiveBlock(bid);
  if (!blk || blk.jenis === "meta") return false;
  if (S.freezeLayout) {
    return !Boolean(S._freezeUnlockedIds && S._freezeUnlockedIds[bid]);
  }
  const st = blk.style;
  return Boolean(st?.frozen && !st?.unlocked_in_freeze);
}

function isBlockFreezeManaged(bid) {
  const S = window.EditorState;
  const st = getEffectiveBlock(bid)?.style;
  return Boolean(
    st?.frozen ||
    st?.unlocked_in_freeze ||
    Math.abs(Number(st?.freeze_x || 0)) > 0.05 ||
    Math.abs(Number(st?.freeze_y || 0)) > 0.05 ||
    S?._localSplitNewIds?.[bid] ||
    (Array.isArray(S?.draft?.splits) && S.draft.splits.some(sp => sp && sp.frozen && (sp.block_id === bid || sp.new_id === bid)))
  );
}

function setFreezeLayoutUi(active) {
  const S = window.EditorState;
  S.freezeLayout = Boolean(active);
  const k = document.getElementById("kanvas-pdf");
  const b = document.getElementById("btn-freeze-layout");
  if (k) k.classList.toggle("freeze-mode", S.freezeLayout);
  if (b) b.classList.toggle("btn-aktif", S.freezeLayout);
}

function getFreezeSlotHeight(bid, fallbackH = 0) {
  const S = window.EditorState;
  const rawBlk = (S.blocks || []).find(b => b.id === bid);
  const effBlk = getEffectiveBlock(bid);
  const existing = Number(rawBlk?.style?.freeze_slot_h || effBlk?.style?.freeze_slot_h || 0);
  if (existing > 1) return Number(existing.toFixed(1));
  const segs = (S.layoutSegments || []).filter(s => s && s.id === bid);
  const uniquePages = new Set(segs.map(s => Number(s.page)));
  if (uniquePages.size > 1) return 0;
  if (segs.length === 1 && Number(segs[0].height) > 1) return Number(Number(segs[0].height).toFixed(1));
  return fallbackH > 1 ? Number(Number(fallbackH).toFixed(1)) : 0;
}

function guardFreezeInspectorEdit(bid) {
  const S = window.EditorState;
  if (S.freezeLayout && isBlockFrozenLocked(bid)) {
    showToast(`🔒 ${bid} masih terkunci! Klik blok 1x di kanvas untuk membuka kunci (🔓) sebelum mengedit.`);
    return false;
  }
  return true;
}

function withFreezeSlotPatch(bid, stylePatch = {}) {
  const S = window.EditorState;
  const out = Object.assign({}, stylePatch);
  if (S.freezeLayout) {
    out.frozen = false;
    out.unlocked_in_freeze = true;
    const slotH = getFreezeSlotHeight(bid, 0);
    if (slotH > 1) out.freeze_slot_h = slotH;
  }
  return out;
}

function setPreviewMode(active) {
  const S = window.EditorState;
  const next = Boolean(active);
  if (next && S.isCutMode) setCutMode(false);
  S.previewMode = next;
  const app = document.getElementById("aplikasi");
  const btn = document.getElementById("btn-preview-mode");
  if (app) app.classList.toggle("preview-mode", next);
  if (btn) {
    btn.classList.toggle("btn-aktif", next);
    btn.textContent = next ? "👁️ Keluar Preview" : "👁️ Preview";
  }
  showToast(next ? "👁️ Preview Mode aktif (tekan Esc untuk keluar)" : "✏️ Kembali ke Mode Editor");
}

function togglePreviewMode() {
  setPreviewMode(!window.EditorState.previewMode);
}

async function renderPdfFromServer(articleId, versi) {
  if (!window.pdfjsLib) return;
  const S = window.EditorState;
  const container = document.getElementById("kanvas-pdf");
  if (!container) return;
  const thisToken = ++_renderToken;
  container.querySelector(".empty-state")?.remove();

  const vp = document.getElementById("viewport-utama");
  const prevScrollTop = vp ? vp.scrollTop : 0;
  const prevScrollLeft = vp ? vp.scrollLeft : 0;
  const url = apiUrl("get_preview", { id: articleId, v: versi || Date.now() });
  const pdfDoc = await window.pdfjsLib.getDocument(url).promise;
  if (thisToken !== _renderToken) return;
  S.pdfDoc = pdfDoc;
  S.halaman = pdfDoc.numPages;
  S.pageTextLines = {};
  S._segCache = null;

  const existing = Array.from(container.querySelectorAll(".pdf-page-sheet"));
  for (let i = pdfDoc.numPages; i < existing.length; i++) existing[i].remove();

  for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
    if (thisToken !== _renderToken) return;
    let sheet = container.querySelector(`.pdf-page-sheet[data-page="${pageNum}"]`);
    if (!sheet) {
      sheet = document.createElement("div");
      sheet.className = "pdf-page-sheet";
      sheet.setAttribute("data-page", String(pageNum));
      sheet.innerHTML = `<div class="pdf-canvas-layer"><canvas class="pdf-page-canvas"></canvas></div><div class="wasm-overlay-layer"></div>`;
      container.appendChild(sheet);
    }
    const page = await pdfDoc.getPage(pageNum);
    await extractPdfPageTextLines(page, pageNum);
    const canvas = sheet.querySelector(".pdf-page-canvas");
    if (canvas) {
      const viewport = page.getViewport({ scale: 1.6 });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    }
    buildInteractiveOverlay(sheet, pageNum);
  }
  if (thisToken === _renderToken) {
    S._segCache = null;
    rebuildAllOverlays();
  }
  if (vp) {
    if (prevScrollTop) vp.scrollTop = prevScrollTop;
    if (prevScrollLeft) vp.scrollLeft = prevScrollLeft;
  }
}

function rebuildAllOverlays() {
  window.EditorState._segCache = null;
  document.querySelectorAll(".pdf-page-sheet").forEach(sheet => {
    const p = parseInt(sheet.dataset.page, 10);
    if (p) buildInteractiveOverlay(sheet, p);
  });
}

function attachBoxHandles(box) {
  ["nw", "n", "ne", "e", "se", "s", "sw", "w"].forEach(dir => {
    const h = document.createElement("div");
    h.className = `handle handle-${dir}`;
    h.dataset.dir = dir;
    h.onpointerdown = e => { e.stopPropagation(); onBoxHandleDown(e, box, dir); };
    box.appendChild(h);
  });
}

function buildInteractiveOverlay(pageEl, pageNum) {
  const S = window.EditorState;
  let overlay = pageEl.querySelector(".wasm-overlay-layer");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "wasm-overlay-layer";
    pageEl.appendChild(overlay);
  }
  overlay.innerHTML = "";

  const allReconstructed = getReconstructedSegments();
  const segments = allReconstructed.filter(seg => Number(seg.page) === Number(pageNum));
  const allSegCountById = {};
  allReconstructed.forEach(s => { allSegCountById[s.id] = (allSegCountById[s.id] || 0) + 1; });

  segments.forEach(seg => {
    const blk = getEffectiveBlock(seg.id);
    const box = document.createElement("div");
    const isSel = isBlockSelected(seg.id);
    const isMulti = isSel && Array.isArray(S.selectedIds) && S.selectedIds.length > 1;
    const isSplitMod = Boolean(S._localSplitNewIds?.[seg.id]) ||
      (Array.isArray(S.draft.splits) && S.draft.splits.some(sp => sp.block_id === seg.id || sp.new_id === seg.id));
    const isMod = !!(S.draft.edits[seg.id] || S.draft.crops[seg.id] || isSplitMod || S.draft.moves.some(m => m.block_ids?.includes(seg.id)));
    const isDel = S.draft.deletes.includes(seg.id);

    box.className = "wasm-box" +
      (isSel ? " selected" : "") +
      (isMulti ? " multi-selected" : "") +
      (isMod ? " draft-modified" : "") +
      (isDel ? " draft-deleted" : "");
    box.dataset.id = seg.id;
    box.dataset.kind = seg.type;
    box.dataset.page = String(pageNum);
    box.dataset.column = String(seg.column);
    if (seg.nomor != null) box.dataset.nomor = String(seg.nomor);
    const rawBlk = S.blocks.find(b => b.id === seg.id);
    const serverAbove = Number(rawBlk?.style?.spacing_above || 0);
    const effAbove = Number(blk?.style?.spacing_above || 0);
    const serverFx = Number(rawBlk?.style?.freeze_x || 0);
    const serverFy = Number(rawBlk?.style?.freeze_y || 0);
    const effFx = Number(blk?.style?.freeze_x || 0);
    const effFy = Number(blk?.style?.freeze_y || 0);
    const dxDraft = Number((effFx - serverFx).toFixed(2));
    const dyDraft = Number(((effFy - serverFy) + (effAbove - serverAbove)).toFixed(2));
    const isLocked = isBlockFrozenLocked(seg.id);
    const isUnlockedFreeze = S.freezeLayout ? !isLocked : Boolean(blk?.style?.unlocked_in_freeze);
    const hasFreezeShift = Math.abs(effFx) > 0.05 || Math.abs(effFy) > 0.05;
    if (seg.type !== "meta") {
      if (S.freezeLayout) {
        if (isLocked) box.classList.add("frozen-box");
        else box.classList.add("unfrozen-active");
      } else if (isLocked) {
        box.classList.add("frozen-box");
      } else if (isUnlockedFreeze) {
        box.classList.add("unfrozen-active");
      } else if (hasFreezeShift) {
        box.classList.add("frozen-box");
      }
    }
    const transformCss = (Math.abs(dxDraft) > 0.05 || Math.abs(dyDraft) > 0.05)
      ? `transform:translate(${dxDraft}pt, ${dyDraft}pt);`
      : "";
    box.style.cssText = `left:${seg.x}pt;top:${seg.y}pt;width:${seg.width}pt;height:${seg.height}pt;${transformCss}`;

    const badge = document.createElement("div");
    badge.className = "wasm-box-badge";
    const multiInfo = (allSegCountById[seg.id] || 1) > 1 ? " ⇄" : "";
    const brkInfo = blk?.style?.break_before === "column" ? " ✂col" : (blk?.style?.break_before === "page" ? " ✂hal" : "");
    const cropInfo = S.draft.crops[seg.id] ? " ✂crop" : "";
    let freezeInfo = "";
    if (seg.type !== "meta") {
      if (S.freezeLayout) {
        const icon = isLocked ? "🔒" : "🔓";
        freezeInfo = hasFreezeShift ? ` ${icon}(${effFx.toFixed(1)}, ${effFy.toFixed(1)})` : ` ${icon}`;
      } else if (isLocked) {
        freezeInfo = hasFreezeShift ? ` 🔒(${effFx.toFixed(1)}, ${effFy.toFixed(1)})` : " 🔒";
      } else if (isUnlockedFreeze) {
        freezeInfo = hasFreezeShift ? ` 🔓(${effFx.toFixed(1)}, ${effFy.toFixed(1)})` : " 🔓";
      } else if (hasFreezeShift) {
        freezeInfo = ` 🔒(${effFx.toFixed(1)}, ${effFy.toFixed(1)})`;
      }
    }
    badge.textContent = `${seg.id} • ${seg.label}${multiInfo}${brkInfo}${cropInfo}${freezeInfo}`;
    box.appendChild(badge);
    attachBoxHandles(box);

    // Multi-segmen hover sinkron di seluruh kolom & halaman
    box.onpointerenter = () => {
      document.querySelectorAll(`.wasm-box[data-id="${CSS.escape(seg.id)}"]`).forEach(el => el.classList.add("hovered"));
    };
    box.onpointerleave = () => {
      document.querySelectorAll(".wasm-box.hovered").forEach(el => el.classList.remove("hovered"));
    };
    box.onpointerdown = e => {
      if (e.target.classList.contains("handle")) return;
      onBoxPointerDown(e, box);
    };
    box.ondblclick = e => {
      e.stopPropagation();
      if (window.EditorState.isCutMode) return;
      selectBlockById(seg.id, pageNum, false);
      if (seg.type === "meta") openMetadataModal(seg.id);
      else document.getElementById("prop-teks")?.focus();
    };
    overlay.appendChild(box);
  });

  const draftKepala = S.draft.header_naik[pageNum];
  const barisKepala = draftKepala !== undefined ? Number(draftKepala) : (Number(S.headerNaikMap[pageNum]) || 0);
  const baseHeaderTop = getPageHeaderBaseTop(pageNum);
  const headerBar = document.createElement("div");
  headerBar.className = "header-handle-bar";
  headerBar.title = "Seret atas/bawah: Margin Atas Kolom (±22pt)";
  headerBar.style.top = `calc(${baseHeaderTop + (barisKepala * 11)}pt - 9px)`;
  headerBar.dataset.page = String(pageNum);
  headerBar.onpointerdown = e => { e.stopPropagation(); onHeaderHandleDown(e, pageNum); };
  overlay.appendChild(headerBar);

  const draftKaki = S.draft.kaki_naik[pageNum];
  const baris = draftKaki !== undefined ? draftKaki : (S.kakiNaikMap[pageNum] || 0);
  const colBar = document.createElement("div");
  colBar.className = "col-handle-bar";
  colBar.title = "Seret atas/bawah: Margin Bawah Kolom (±22pt)";
  colBar.style.top = `${762.4 - (baris * 11)}pt`;
  colBar.dataset.page = String(pageNum);
  colBar.onpointerdown = e => { e.stopPropagation(); onColHandleDown(e, pageNum); };
  overlay.appendChild(colBar);
}

function markModifiedBoxesOnDom() {
  const S = window.EditorState;
  document.querySelectorAll(".wasm-box").forEach(box => {
    const id = box.dataset.id;
    const isSplitMod = Boolean(S._localSplitNewIds?.[id]) ||
      (Array.isArray(S.draft.splits) && S.draft.splits.some(sp => sp.block_id === id || sp.new_id === id));
    const isMod = !!(S.draft.edits[id] || S.draft.crops[id] || isSplitMod || S.draft.moves.some(m => m.block_ids?.includes(id)));
    const isDel = S.draft.deletes.includes(id);
    box.classList.toggle("draft-modified", isMod);
    box.classList.toggle("draft-deleted", isDel);
  });
}

// ==================== 4. SELECT OBJECT NAVIGATOR & INSPECTOR ====================
function renderObjectNavigator() {
  const S = window.EditorState;
  const ul = document.getElementById("daftar-objek");
  if (!ul) return;
  const q = (document.getElementById("cari-objek")?.value || "").trim().toLowerCase();
  const jenisFilter = document.getElementById("filter-jenis-objek")?.value || "all";

  const firstPageById = {};
  getReconstructedSegments().forEach(s => {
    if (!firstPageById[s.id] || s.page < firstPageById[s.id]) firstPageById[s.id] = s.page;
  });

  const filtered = S.blocks.filter(b => {
    if (jenisFilter !== "all") {
      if (jenisFilter === "paragraph") {
        if (!["paragraph", "list_item", "labeled_paragraph", "quote"].includes(b.jenis)) return false;
      } else if (b.jenis !== jenisFilter) {
        return false;
      }
    }
    if (!q) return true;
    return (b.id || "").toLowerCase().includes(q) ||
           (b.judul || "").toLowerCase().includes(q) ||
           (b.text || "").toLowerCase().includes(q);
  });

  ul.innerHTML = filtered.map(b => {
    const eff = getEffectiveBlock(b.id) || b;
    const hal = firstPageById[b.id] || 1;
    const cuplik = (eff.text || "").replace(/\s+/g, " ").slice(0, 65) || "(kosong)";
    return `<li data-oid="${b.id}" data-hal="${hal}" class="${isBlockSelected(b.id) ? "aktif" : ""}">
      <div class="obj-item-top">
        <span>${b.id} • ${b.judul || b.jenis}</span>
        <span class="obj-pill">Hlm ${hal}</span>
      </div>
      <div class="obj-item-sub">${cuplik.replace(/</g, "&lt;")}</div>
    </li>`;
  }).join("");

  ul.querySelectorAll("li[data-oid]").forEach(li => {
    li.onclick = ev => {
      const additive = Boolean(ev && (ev.shiftKey || ev.ctrlKey || ev.metaKey));
      selectBlockById(li.dataset.oid, parseInt(li.dataset.hal, 10) || 1, !additive, { additive });
    };
  });
}

function populateMoveTargetSelect(excludeIds = []) {
  const sel = document.getElementById("prop-target-id");
  if (!sel) return;
  const prevVal = sel.value;
  const exSet = new Set(Array.isArray(excludeIds) ? excludeIds : []);
  const nonMeta = window.EditorState.blocks.filter(b => b.jenis !== "meta" && !exSet.has(b.id));
  sel.innerHTML = nonMeta.map(b => {
    const txt = (b.text || "").replace(/\s+/g, " ").slice(0, 32);
    return `<option value="${b.id}">${b.id} (${b.judul || b.jenis}) — ${txt.replace(/</g, "&lt;")}</option>`;
  }).join("");
  if (prevVal && nonMeta.some(b => b.id === prevVal)) sel.value = prevVal;
}

function scrollToPage(pageNum) {
  const sheet = document.querySelector(`.pdf-page-sheet[data-page="${pageNum}"]`);
  if (sheet) sheet.scrollIntoView({ behavior: "smooth", block: "start" });
}

function ensureSelectOption(sel, valStr, labelStr) {
  if (!sel) return;
  if (!Array.from(sel.options).some(o => o.value === valStr)) {
    const opt = document.createElement("option");
    opt.value = valStr;
    opt.textContent = labelStr;
    sel.appendChild(opt);
  }
  sel.value = valStr;
}

function ensureParagraphFlowControls() {
  const grpPar = document.getElementById("grup-prop-paragraf");
  if (!grpPar || document.getElementById("prop-spasi-bawah")) return;
  const wrap = document.createElement("div");
  wrap.className = "prop-group-extra";
  wrap.style.cssText = "display:flex;flex-direction:column;gap:8px;";
  wrap.innerHTML = `
    <label>Spasi Bawah Blok (kelipatan 11pt)
      <select id="prop-spasi-bawah">
        <option value="-22">-22 pt (-2 Baris)</option>
        <option value="-11">-11 pt (-1 Baris)</option>
        <option value="0">0 pt (Standar)</option>
        <option value="11">11 pt (+1 Baris)</option>
        <option value="22">22 pt (+2 Baris)</option>
        <option value="33">33 pt (+3 Baris)</option>
        <option value="44">44 pt (+4 Baris)</option>
      </select>
    </label>
    <label>Aliran Kerapatan Teks (Tracking): <span id="prop-tracking-val">0.00 pt</span>
      <input type="range" id="prop-tracking" min="-0.40" max="0.40" step="0.02" value="0">
    </label>`;
  grpPar.appendChild(wrap);
  const selBawah = document.getElementById("prop-spasi-bawah");
  selBawah?.addEventListener("change", e => {
    const bid = window.EditorState.selectedId;
    if (bid) {
      if (!guardFreezeInspectorEdit(bid)) return;
      recordEditDraft(bid, { style: withFreezeSlotPatch(bid, { spacing_below: parseFloat(e.target.value) || 0 }) });
      scheduleAutoSave();
    }
  });
  const trkIn = document.getElementById("prop-tracking");
  trkIn?.addEventListener("input", e => {
    const v = parseFloat(e.target.value) || 0;
    const lbl = document.getElementById("prop-tracking-val");
    if (lbl) lbl.textContent = `${v >= 0 ? "+" : ""}${v.toFixed(2)} pt`;
  });
  trkIn?.addEventListener("change", e => {
    const bid = window.EditorState.selectedId;
    if (bid) {
      if (!guardFreezeInspectorEdit(bid)) return;
      recordEditDraft(bid, { style: withFreezeSlotPatch(bid, { tracking: Number((parseFloat(e.target.value) || 0).toFixed(3)) }) });
      scheduleAutoSave();
    }
  });
}

function isBlockSelected(bid) {
  if (!bid) return false;
  const S = window.EditorState;
  if (Array.isArray(S.selectedIds) && S.selectedIds.includes(bid)) return true;
  return S.selectedId === bid;
}

function getOrderedMovableIds(ids) {
  const S = window.EditorState;
  const seen = new Set();
  const orderMap = new Map();
  (S.blocks || []).forEach((b, idx) => orderMap.set(b.id, idx));
  const out = [];
  (Array.isArray(ids) ? ids : []).forEach(id => {
    if (!id || seen.has(id)) return;
    if (S.draft.deletes.includes(id)) return;
    const blk = getEffectiveBlock(id);
    if (blk && blk.jenis === "meta") return;
    seen.add(id);
    out.push(id);
  });
  out.sort((a, b) => {
    const ia = orderMap.has(a) ? orderMap.get(a) : Number.MAX_SAFE_INTEGER;
    const ib = orderMap.has(b) ? orderMap.get(b) : Number.MAX_SAFE_INTEGER;
    return ia - ib;
  });
  return out;
}

function syncSelectionDom() {
  const S = window.EditorState;
  const isMulti = Array.isArray(S.selectedIds) && S.selectedIds.length > 1;
  document.querySelectorAll(".wasm-box").forEach(box => {
    const id = box.dataset.id;
    const isSel = isBlockSelected(id);
    box.classList.toggle("selected", isSel);
    box.classList.toggle("multi-selected", isSel && isMulti);
  });
  document.querySelectorAll("#daftar-objek li[data-oid]").forEach(li => {
    li.classList.toggle("aktif", isBlockSelected(li.dataset.oid));
  });
}

function formatMarginOffsetText(baris) {
  const b = Number(baris) || 0;
  return `${b > 0 ? "+" : ""}${b * 11} pt (${b > 0 ? "+" : ""}${b} baris)`;
}

function syncHeaderFooterControls(page = 1) {
  const S = window.EditorState;
  const pageNum = Number(page) || 1;
  const lblHal = document.getElementById("lbl-hal-aktif");
  if (lblHal) lblHal.textContent = `${pageNum} (cetak ${S.halamanAwal + pageNum - 1})`;

  const kepalaVal = S.draft.header_naik[pageNum] !== undefined ? S.draft.header_naik[pageNum] : (S.headerNaikMap[pageNum] || 0);
  const kepalaInput = document.getElementById("prop-kepala-turun");
  const kepalaTxt = document.getElementById("prop-kepala-val");
  if (kepalaInput) kepalaInput.value = String(kepalaVal);
  if (kepalaTxt) kepalaTxt.textContent = formatMarginOffsetText(kepalaVal);

  const kakiVal = S.draft.kaki_naik[pageNum] !== undefined ? S.draft.kaki_naik[pageNum] : (S.kakiNaikMap[pageNum] || 0);
  const kakiInput = document.getElementById("prop-kaki-naik");
  const kakiTxt = document.getElementById("prop-kaki-val");
  if (kakiInput) kakiInput.value = String(kakiVal);
  if (kakiTxt) kakiTxt.textContent = formatMarginOffsetText(kakiVal);
}

function setSelection(ids, primaryId = null, pageHint = null, shouldScroll = false) {
  const S = window.EditorState;
  const uniq = Array.from(new Set((Array.isArray(ids) ? ids : []).filter(Boolean)));
  S.selectedIds = uniq;
  const bid = (primaryId && uniq.includes(primaryId))
    ? primaryId
    : (uniq.length > 0 ? uniq[uniq.length - 1] : null);
  S.selectedId = bid;

  syncSelectionDom();

  const panel = document.getElementById("panel-properti");
  const grpTeks = document.getElementById("grup-prop-teks");
  const grpObj = document.getElementById("grup-prop-objek");
  const grpPar = document.getElementById("grup-prop-paragraf");
  const info = document.getElementById("prop-info");

  if (uniq.length === 0) {
    if (panel) panel.hidden = !S.articleId;
    if (grpTeks) grpTeks.hidden = true;
    if (grpObj) grpObj.hidden = true;
    if (grpPar) grpPar.hidden = true;
    if (info) info.innerHTML = "Klik blok di kanvas atau seret area kosong kanvas (marquee) untuk memilih beberapa objek.";
    populateMoveTargetSelect([]);
    syncHeaderFooterControls(S.activePage || 1);
    return;
  }

  if (panel) panel.hidden = false;

  const segs = getReconstructedSegments().filter(s => s.id === bid);
  const page = pageHint || segs[0]?.page || S.activePage || 1;
  S.activePage = page;

  if (shouldScroll && bid) {
    const primaryBox = document.querySelector(`.wasm-box[data-id="${CSS.escape(bid)}"]`);
    if (primaryBox) primaryBox.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  syncHeaderFooterControls(page);

  if (uniq.length > 1) {
    populateMoveTargetSelect(uniq);
    if (info) {
      info.innerHTML = `<b>${uniq.length} Objek Terpilih</b><br>ID: <code>${uniq.join(", ")}</code>` +
        `<br><small>Seret salah satu objek terpilih untuk memindahkan semuanya bersamaan, atau gunakan pindah target di bawah.</small>`;
    }
    if (grpTeks) grpTeks.hidden = true;
    if (grpPar) grpPar.hidden = true;
    if (grpObj) grpObj.hidden = false;
    const btnCrop = document.getElementById("btn-buka-crop");
    if (btnCrop) btnCrop.hidden = true;
    const btnDel = document.getElementById("btn-hapus-blok");
    if (btnDel) btnDel.disabled = false;
    return;
  }

  populateMoveTargetSelect([bid]);
  const blk = getEffectiveBlock(bid);
  if (!blk) {
    if (grpTeks) grpTeks.hidden = true;
    if (grpObj) grpObj.hidden = true;
    if (grpPar) grpPar.hidden = true;
    return;
  }

  document.getElementById("prop-id").value = blk.id;
  document.getElementById("prop-jenis").value = blk.jenis;
  document.getElementById("prop-hal").value = String(page);
  document.getElementById("prop-nomor").value = blk.nomor ?? "";

  const isLocked = isBlockFrozenLocked(blk.id);
  const isUnlockedFreeze = S.freezeLayout ? !isLocked : Boolean(blk.style?.unlocked_in_freeze);
  const fxVal = Number(blk.style?.freeze_x || 0);
  const fyVal = Number(blk.style?.freeze_y || 0);
  const hasFreezeShift = Math.abs(fxVal) > 0.05 || Math.abs(fyVal) > 0.05;
  let freezeDesc = "";
  if (blk.jenis !== "meta") {
    if (isLocked || (!S.freezeLayout && !isUnlockedFreeze && hasFreezeShift)) {
      freezeDesc = ` <span style="color:#0891b2;font-weight:bold;">🔒 [Terkunci / Frozen: (${fxVal.toFixed(1)}, ${fyVal.toFixed(1)})]</span>`;
    } else if (S.freezeLayout || isUnlockedFreeze) {
      freezeDesc = ` <span style="color:#d97706;font-weight:bold;">🔓 [Terbuka — Siap Digeser: (${fxVal.toFixed(1)}, ${fyVal.toFixed(1)})]</span>`;
    }
  }
  const segDesc = segs.length > 1 ? `${segs.length} segmen lintas kolom/hlm` : `Halaman ${page}`;
  if (info) {
    info.innerHTML = `<b>${blk.id}</b> — ${blk.judul || blk.jenis} (${segDesc})${freezeDesc}` +
      (blk.jenis === "meta" ? `<br><small>Klik tombol <b>📝 Metadata</b> untuk form lengkap semua field halaman 1.</small>` : "");
  }

  if (grpTeks) grpTeks.hidden = false;
  const areaTeks = document.getElementById("prop-teks");
  if (areaTeks && document.activeElement !== areaTeks) areaTeks.value = blk.text || "";
  const btnDel = document.getElementById("btn-hapus-blok");
  if (btnDel) btnDel.disabled = blk.jenis === "meta";

  if (blk.jenis === "figure" || blk.jenis === "table") {
    if (grpObj) grpObj.hidden = false;
    if (grpPar) grpPar.hidden = true;
    const defaultPct = blk.jenis === "table"
      ? Math.round((Number(blk.style?.font_size ?? 11) / 11) * 100)
      : 100;
    const pct = Math.round(Number(blk.style?.width_pct ?? defaultPct));
    const skalaEl = document.getElementById("prop-skala");
    if (skalaEl) {
      skalaEl.min = "50";
      skalaEl.max = "130";
      skalaEl.value = String(pct);
    }
    document.getElementById("prop-skala-val").textContent = `${pct}%`;
    document.getElementById("prop-keputusan").value = blk.style?.placement || "auto";
    document.getElementById("prop-penuh").checked = (blk.style?.span === "page");
    const btnCrop = document.getElementById("btn-buka-crop");
    if (btnCrop) {
      btnCrop.hidden = !(blk.jenis === "figure" || blk.jenis === "table");
      btnCrop.textContent = blk.jenis === "table" ? "✂️ Crop Tabel Ini..." : "✂️ Crop Gambar Ini...";
    }
  } else if (blk.jenis === "meta") {
    if (grpObj) grpObj.hidden = true;
    if (grpPar) grpPar.hidden = true;
  } else {
    if (grpObj) grpObj.hidden = true;
    if (grpPar) grpPar.hidden = false;
    ensureParagraphFlowControls();
    document.getElementById("prop-break-before").value = blk.style?.break_before || "none";
    const spAtas = Math.round(Number(blk.style?.spacing_above || 0));
    ensureSelectOption(document.getElementById("prop-spasi-atas"), String(spAtas), `${spAtas} pt (${Math.round(spAtas / 11)} Baris)`);
    const spBawah = Math.round(Number(blk.style?.spacing_below || 0));
    ensureSelectOption(document.getElementById("prop-spasi-bawah"), String(spBawah), `${spBawah} pt (${Math.round(spBawah / 11)} Baris)`);
    const trk = Number(blk.style?.tracking || 0);
    const trkEl = document.getElementById("prop-tracking");
    const trkLbl = document.getElementById("prop-tracking-val");
    if (trkEl) trkEl.value = String(trk);
    if (trkLbl) trkLbl.textContent = `${trk >= 0 ? "+" : ""}${trk.toFixed(2)} pt`;
  }
}

function selectBlockById(bid, pageHint = null, shouldScroll = false, opts = {}) {
  const S = window.EditorState;
  const additive = Boolean(opts && opts.additive);
  if (additive) {
    if (!bid) return;
    const baseIds = (S.selectedIds || []).filter(id => {
      const b = getEffectiveBlock(id);
      return b && b.jenis !== "meta";
    });
    const blk = getEffectiveBlock(bid);
    if (blk && blk.jenis === "meta" && baseIds.length > 0) {
      setSelection([bid], bid, pageHint, shouldScroll);
      return;
    }
    const idx = baseIds.indexOf(bid);
    if (idx >= 0) {
      const next = baseIds.filter(id => id !== bid);
      setSelection(next, next[next.length - 1] || null, pageHint, false);
    } else {
      setSelection([...baseIds, bid], bid, pageHint, shouldScroll);
    }
    return;
  }
  setSelection(bid ? [bid] : [], bid || null, pageHint, shouldScroll);
}

// ==================== 5. DRAG-AND-DROP MULUS (SKALA PT PRESISI + DROP INDICATOR) ====================
const GRID_STEP_PT = 11;
const GRID_ORIGIN_Y_PT = 102.4;
const PAGE_WIDTH_PT = 595.28;
const COL1_LEFT_PT = 76.54;
const COL2_LEFT_PT = 305.14;
const COL_WIDTH_PT = 213.6;
const PAGE_SPAN_WIDTH_PT = 442.2;

function isGridSnapActive() {
  return Boolean(window.EditorState?.showGrid);
}

function snapYToGrid(yPt) {
  return Number((GRID_ORIGIN_Y_PT + Math.round((yPt - GRID_ORIGIN_Y_PT) / GRID_STEP_PT) * GRID_STEP_PT).toFixed(2));
}

function snapHeightToGrid(hPt, minH = GRID_STEP_PT) {
  return Math.max(minH, Math.round(hPt / GRID_STEP_PT) * GRID_STEP_PT);
}

function getBoxSpanAndColumnInfo(boxOrId) {
  const bid = typeof boxOrId === "string" ? boxOrId : boxOrId?.dataset?.id;
  const boxEl = typeof boxOrId === "string" ? null : boxOrId;
  const blk = bid ? getEffectiveBlock(bid) : null;
  const origLeft = boxEl ? (parseFloat(boxEl.style.left) || COL1_LEFT_PT) : COL1_LEFT_PT;
  const origW = boxEl ? (parseFloat(boxEl.style.width) || COL_WIDTH_PT) : COL_WIDTH_PT;
  const colAttr = boxEl ? parseInt(boxEl.dataset.column, 10) : NaN;
  const isSpanPage = (blk?.style?.span === "page") || colAttr === 0 || origW > 295;
  let colNum = 0;
  if (!isSpanPage) {
    colNum = (colAttr === 1 || colAttr === 2) ? colAttr : (origLeft < 295 ? 1 : 2);
  }
  return { isSpanPage, colNum, origW };
}

function clampXToColumn(xPt, widthPt, colNum) {
  const colMinX = colNum === 2 ? COL2_LEFT_PT : COL1_LEFT_PT;
  const colMaxX = colMinX + COL_WIDTH_PT;
  const maxLeft = Math.max(colMinX, colMaxX - widthPt);
  return Math.max(colMinX, Math.min(maxLeft, xPt));
}

function getPtPerPx(el) {
  const sheet = el?.closest?.(".pdf-page-sheet") || document.querySelector(".pdf-page-sheet");
  if (!sheet) return 0.75;
  const rect = sheet.getBoundingClientRect();
  return rect.width > 10 ? (595.28 / rect.width) : 0.75;
}

function removeDropIndicators() {
  document.querySelectorAll(".drop-indicator-line").forEach(el => el.remove());
}

function getBoxClientRect(box) {
  const r = box.getBoundingClientRect ? box.getBoundingClientRect() : { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  const sheet = box.closest?.(".pdf-page-sheet");
  const sheetRect = sheet?.getBoundingClientRect?.();
  const sw = parseFloat(box.style?.width);
  const sh = parseFloat(box.style?.height);
  const sl = parseFloat(box.style?.left);
  const st = parseFloat(box.style?.top);
  const isSyntheticFullSheet = sheetRect && r.width === sheetRect.width && r.left === sheetRect.left && r.top === sheetRect.top &&
    Number.isFinite(sw) && sw > 0 && sw < sheetRect.width * 0.99;
  if ((r.width === 0 || isSyntheticFullSheet) && sheetRect && Number.isFinite(sl) && Number.isFinite(st) && Number.isFinite(sw) && Number.isFinite(sh)) {
    const ptPerPx = getPtPerPx(box);
    const left = sheetRect.left + (sl / ptPerPx);
    const top = sheetRect.top + (st / ptPerPx);
    const width = sw / ptPerPx;
    const height = sh / ptPerPx;
    return { left, top, width, height, right: left + width, bottom: top + height };
  }
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
}

function applyLocalMoveToBlocks(orderedIds, targetId, position) {
  const S = window.EditorState;
  const movingSet = new Set(orderedIds);
  const movingBlocks = S.blocks.filter(b => movingSet.has(b.id));
  if (movingBlocks.length === 0 || !S.blocks.some(b => b.id === targetId)) return;
  const remaining = S.blocks.filter(b => !movingSet.has(b.id));
  const idxT = remaining.findIndex(b => b.id === targetId);
  if (idxT < 0) return;
  const insertAt = position === "before" ? idxT : idxT + 1;
  remaining.splice(insertAt, 0, ...movingBlocks);
  S.blocks = remaining;
}

function onCanvasPointerDown(e) {
  if (e.button !== 0) return;
  const S = window.EditorState;
  if (!S.articleId) return;
  if (S.isCutMode) return;
  if (e.target?.closest?.(".wasm-box, .handle, .col-handle-bar, .header-handle-bar, .server-loading-overlay, button, input, select, textarea, a")) return;

  const vp = document.getElementById("viewport-utama");
  if (vp && vp.clientWidth > 0 && vp.clientHeight > 0 && vp.getBoundingClientRect) {
    const vpRect = vp.getBoundingClientRect();
    if (e.clientX > vpRect.left + vp.clientWidth || e.clientY > vpRect.top + vp.clientHeight) return;
  }

  e.preventDefault?.();
  cancelAutoSave();
  const additive = Boolean(e.shiftKey || e.ctrlKey || e.metaKey);
  const initialSelectedIds = additive
    ? (S.selectedIds || []).filter(id => {
        const b = getEffectiveBlock(id);
        return b && b.jenis !== "meta";
      })
    : [];

  S.pointer = {
    mode: "marquee",
    started: false,
    startX: e.clientX,
    startY: e.clientY,
    additive,
    initialSelectedIds,
    hitIds: [],
    skippedLockedInMarquee: 0,
    marqueeEl: null
  };
}

function onBoxPointerDown(e, boxEl) {
  if (e.button !== 0) return;
  e.stopPropagation?.();
  const S = window.EditorState;
  if (S.isCutMode) {
    e.preventDefault?.();
    handleVisualCutClick(e, boxEl);
    return;
  }
  e.preventDefault?.();
  cancelAutoSave();
  const bid = boxEl.dataset.id;
  const kind = boxEl.dataset.kind;
  const page = parseInt(boxEl.dataset.page, 10) || 1;
  const additive = Boolean(e.shiftKey || e.ctrlKey || e.metaKey);

  if (kind === "meta") {
    setSelection([bid], bid, page, false);
    return;
  }

  let toggleOffOnClick = false;
  let collapseToSingleOnClick = false;

  if (additive) {
    const baseIds = (S.selectedIds || []).filter(id => {
      const b = getEffectiveBlock(id);
      return b && b.jenis !== "meta";
    });
    if (baseIds.includes(bid)) {
      toggleOffOnClick = true;
    } else {
      setSelection([...baseIds, bid], bid, page, false);
    }
  } else {
    if (isBlockSelected(bid) && Array.isArray(S.selectedIds) && S.selectedIds.length > 1) {
      collapseToSingleOnClick = true;
      S.selectedId = bid;
      syncSelectionDom();
    } else {
      setSelection([bid], bid, page, false);
    }
  }

  const wasLockedOnDown = isBlockFrozenLocked(bid);
  const useFreezeMode = Boolean(S.freezeLayout || (!S._freezeExplicitlyOff && isBlockFreezeManaged(bid)));
  let dragIds = getOrderedMovableIds(isBlockSelected(bid) ? S.selectedIds : [bid]);
  if (useFreezeMode && !wasLockedOnDown) {
    dragIds = dragIds.filter(id => !isBlockFrozenLocked(id));
  }
  const dragIdSet = new Set(dragIds.length ? dragIds : [bid]);
  const dragBoxItems = [];
  document.querySelectorAll(".wasm-box").forEach(el => {
    if (dragIdSet.has(el.dataset.id)) {
      if (useFreezeMode && !wasLockedOnDown && isBlockFrozenLocked(el.dataset.id)) return;
      const colInfo = getBoxSpanAndColumnInfo(el);
      const itRaw = S.blocks.find(b => b.id === el.dataset.id);
      const itEff = getEffectiveBlock(el.dataset.id);
      const srvFx = Number(itRaw?.style?.freeze_x || 0);
      const srvFy = Number(itRaw?.style?.freeze_y || 0);
      const effFx = Number(itEff?.style?.freeze_x || 0);
      const effFy = Number(itEff?.style?.freeze_y || 0);
      const srvAbv = Number(itRaw?.style?.spacing_above || 0);
      const effAbv = Number(itEff?.style?.spacing_above || 0);
      dragBoxItems.push({
        el,
        bid: el.dataset.id,
        page: parseInt(el.dataset.page, 10) || 1,
        origLeft: parseFloat(el.style.left) || 0,
        origTop: parseFloat(el.style.top) || 0,
        origW: colInfo.origW,
        colNum: colInfo.colNum,
        isSpanPage: colInfo.isSpanPage,
        origFx: effFx,
        origFy: effFy,
        baseDx: effFx - srvFx,
        baseDy: (effFy - srvFy) + (effAbv - srvAbv)
      });
    }
  });
  if (!dragBoxItems.some(it => it.el === boxEl)) {
    const colInfo = getBoxSpanAndColumnInfo(boxEl);
    const itRaw = S.blocks.find(b => b.id === bid);
    const itEff = getEffectiveBlock(bid);
    const srvFx = Number(itRaw?.style?.freeze_x || 0);
    const srvFy = Number(itRaw?.style?.freeze_y || 0);
    const effFx = Number(itEff?.style?.freeze_x || 0);
    const effFy = Number(itEff?.style?.freeze_y || 0);
    const srvAbv = Number(itRaw?.style?.spacing_above || 0);
    const effAbv = Number(itEff?.style?.spacing_above || 0);
    dragBoxItems.push({
      el: boxEl,
      bid,
      page,
      origLeft: parseFloat(boxEl.style.left) || 0,
      origTop: parseFloat(boxEl.style.top) || 0,
      origW: colInfo.origW,
      colNum: colInfo.colNum,
      isSpanPage: colInfo.isSpanPage,
      origFx: effFx,
      origFy: effFy,
      baseDx: effFx - srvFx,
      baseDy: (effFy - srvFy) + (effAbv - srvAbv)
    });
  }

  const rawBlk = S.blocks.find(b => b.id === bid);
  const effBlk = getEffectiveBlock(bid);
  const serverSpacingAbove = Number(rawBlk?.style?.spacing_above || 0);
  const origSpacingAbove = Number(effBlk?.style?.spacing_above || 0);

  S.pointer = {
    mode: "drag-block",
    started: false,
    startX: e.clientX,
    startY: e.clientY,
    ptPerPx: getPtPerPx(boxEl),
    origLeft: parseFloat(boxEl.style.left) || 0,
    origTop: parseFloat(boxEl.style.top) || 0,
    boxEl,
    bid,
    kind,
    page,
    additive,
    useFreezeMode,
    wasLockedOnDown,
    blockedLockedDrag: false,
    dragIds: Array.from(dragIdSet),
    dragBoxItems,
    isSpanPage: dragBoxItems.some(it => it.isSpanPage),
    toggleOffOnClick,
    collapseToSingleOnClick,
    dropTargetId: null,
    dropPos: "before",
    floatPlacement: null,
    serverSpacingAbove,
    origSpacingAbove,
    nextSpacingAbove: origSpacingAbove,
    dragModeLocked: null,
    nudgeApplied: false
  };
}

function onBoxHandleDown(e, boxEl, dir) {
  if (e.button !== undefined && e.button !== 0) return;
  if (window.EditorState.isCutMode) return;
  cancelAutoSave();
  const S = window.EditorState;
  const bid = boxEl.dataset.id;
  const kind = boxEl.dataset.kind;
  if (kind === "meta") return;
  const freezeCtx = Boolean(S.freezeLayout || (!S._freezeExplicitlyOff && isBlockFreezeManaged(bid)));
  if (freezeCtx && isBlockFrozenLocked(bid)) {
    showToast(`🔒 ${bid} masih terkunci! Klik 1x untuk membuka kunci (🔓) sebelum mengubah ukuran.`);
    return;
  }
  const page = parseInt(boxEl.dataset.page, 10) || 1;
  selectBlockById(bid, page, false);
  const blk = getEffectiveBlock(bid);
  const origLeft = parseFloat(boxEl.style.left) || 76.54;
  const origTop = parseFloat(boxEl.style.top) || 102.4;
  const origW = parseFloat(boxEl.style.width) || 213.6;
  const origH = Math.max(11, parseFloat(boxEl.style.height) || 33);

  if (kind === "figure" || kind === "table") {
    const defaultPct = kind === "table"
      ? Math.round((Number(blk?.style?.font_size ?? 11) / 11) * 100)
      : 100;
    window.EditorState.pointer = {
      mode: "resize-box",
      startX: e.clientX,
      startY: e.clientY,
      ptPerPx: getPtPerPx(boxEl),
      origLeft,
      origTop,
      origW,
      origH,
      aspect: origW / Math.max(12, origH),
      origSpan: blk?.style?.span || (origW > 295 ? "page" : "column"),
      isCorner: dir.length === 2,
      boxEl,
      bid,
      kind,
      dir,
      initialPct: Number(blk?.style?.width_pct ?? defaultPct),
      inFreezeMode: freezeCtx,
      origSlotH: freezeCtx ? getFreezeSlotHeight(bid, origH) : 0
    };
  } else {
    window.EditorState.pointer = {
      mode: "resize-text",
      startX: e.clientX,
      startY: e.clientY,
      ptPerPx: getPtPerPx(boxEl),
      origLeft,
      origTop,
      origW,
      origH,
      origSpacingAbove: Number(blk?.style?.spacing_above || 0),
      origSpacingBelow: Number(blk?.style?.spacing_below || 0),
      origTracking: Number(blk?.style?.tracking || 0),
      textLen: (blk?.text || "").length,
      boxEl,
      bid,
      kind,
      page,
      dir,
      inFreezeMode: freezeCtx,
      origFx: Number(blk?.style?.freeze_x || 0),
      origFy: Number(blk?.style?.freeze_y || 0),
      origLeading: Number(blk?.style?.leading || 0),
      origFreezeW: Number(blk?.style?.freeze_w || 0),
      origSlotH: freezeCtx ? getFreezeSlotHeight(bid, origH) : 0,
      estLines: Math.max(1, Math.round(origH / 11))
    };
  }
}

function onColHandleDown(e, pageNum) {
  cancelAutoSave();
  const S = window.EditorState;
  const pNum = parseInt(pageNum, 10);
  const baris = S.draft.kaki_naik[pNum] !== undefined ? S.draft.kaki_naik[pNum] : (S.kakiNaikMap[pNum] || 0);
  S.pointer = {
    mode: "col-handle",
    startY: e.clientY,
    ptPerPx: getPtPerPx(e.currentTarget),
    pageNum: pNum,
    origKaki: baris,
    colBar: e.currentTarget
  };
}

function onHeaderHandleDown(e, pageNum) {
  cancelAutoSave();
  const S = window.EditorState;
  const pNum = parseInt(pageNum, 10);
  const baris = S.draft.header_naik[pNum] !== undefined ? S.draft.header_naik[pNum] : (S.headerNaikMap[pNum] || 0);
  S.pointer = {
    mode: "header-handle",
    startY: e.clientY,
    ptPerPx: getPtPerPx(e.currentTarget),
    pageNum: pNum,
    origKepala: baris,
    baseHeaderTop: getPageHeaderBaseTop(pNum),
    headerBar: e.currentTarget
  };
}

function findDropTargetAtClientPoint(clientX, clientY, draggedIdOrIds, opts = {}) {
  const S = window.EditorState;
  const excludedList = Array.isArray(draggedIdOrIds)
    ? draggedIdOrIds.filter(Boolean)
    : (draggedIdOrIds ? [draggedIdOrIds] : []);
  const excludedIds = new Set(excludedList);
  let isSpanPage = Boolean(opts && opts.isSpanPage);
  if (!isSpanPage && excludedList.length === 1) {
    const escapedId = (typeof CSS !== "undefined" && typeof CSS.escape === "function")
      ? CSS.escape(excludedList[0])
      : excludedList[0].replace(/"/g, '\\"');
    const boxEl = document.querySelector(`.wasm-box[data-id="${escapedId}"]`);
    isSpanPage = getBoxSpanAndColumnInfo(boxEl || excludedList[0]).isSpanPage;
  }
  const sheets = Array.from(document.querySelectorAll(".pdf-page-sheet"));
  for (const sheet of sheets) {
    const sRect = sheet.getBoundingClientRect();
    if (clientX < sRect.left || clientX > sRect.right || clientY < sRect.top || clientY > sRect.bottom) continue;
    const ptPerPx = 595.28 / sRect.width;
    const relXPt = (clientX - sRect.left) * ptPerPx;
    const relYPt = (clientY - sRect.top) * ptPerPx;

    let best = null;
    let bestDist = Infinity;
    sheet.querySelectorAll(".wasm-box").forEach(cand => {
      const cid = cand.dataset.id;
      const ckind = cand.dataset.kind;
      if (!cid || excludedIds.has(cid) || ckind === "meta") return;
      if (S.freezeLayout && isBlockFrozenLocked(cid)) return;
      const rawCand = (S.blocks || []).find(b => b.id === cid);
      const effCand = getEffectiveBlock(cid);
      const dxOff = Number(effCand?.style?.freeze_x || 0) - Number(rawCand?.style?.freeze_x || 0);
      const dyOff = (Number(effCand?.style?.freeze_y || 0) - Number(rawCand?.style?.freeze_y || 0)) +
        (Number(effCand?.style?.spacing_above || 0) - Number(rawCand?.style?.spacing_above || 0));
      const cx = (parseFloat(cand.style.left) || 0) + dxOff;
      const cy = (parseFloat(cand.style.top) || 0) + dyOff;
      const cw = parseFloat(cand.style.width) || 213.6;
      const ch = parseFloat(cand.style.height) || 20;
      const sameCol = relXPt >= cx - 20 && relXPt <= cx + cw + 20;
      const midY = cy + ch / 2;
      const pos = relYPt < midY ? "before" : "after";
      const edgeY = pos === "before" ? cy : (cy + ch);
      const edgeDist = Math.abs(relYPt - edgeY);
      const colPenalty = isSpanPage ? (sameCol ? 0 : 1) : (sameCol ? 0 : 180);
      const dist = edgeDist + colPenalty;
      if (dist < bestDist) {
        bestDist = dist;
        best = {
          sheet,
          targetId: cid,
          pos,
          lineX: isSpanPage ? COL1_LEFT_PT : cx,
          lineW: isSpanPage ? PAGE_SPAN_WIDTH_PT : cw,
          lineY: edgeY,
          relYPt
        };
      }
    });
    return best;
  }
  return null;
}

function onPointerMove(e) {
  if (window.EditorState.cropDrag) {
    onCropPointerMove(e);
    return;
  }
  const S = window.EditorState;
  if (S.isCutMode) {
    updateCutGuideOnMove(e);
    return;
  }
  const p = S.pointer;
  if (!p) return;

  if (p.mode === "marquee") {
    const dx = e.clientX - p.startX;
    const dy = e.clientY - p.startY;
    if (!p.started && Math.hypot(dx, dy) < 4) return;
    p.started = true;

    if (!p.marqueeEl) {
      const mEl = document.createElement("div");
      mEl.className = "marquee-selection-box";
      document.body?.appendChild(mEl);
      p.marqueeEl = mEl;
    }

    const mLeft = Math.min(p.startX, e.clientX);
    const mTop = Math.min(p.startY, e.clientY);
    const mRight = Math.max(p.startX, e.clientX);
    const mBottom = Math.max(p.startY, e.clientY);
    if (p.marqueeEl) {
      p.marqueeEl.style.left = `${mLeft}px`;
      p.marqueeEl.style.top = `${mTop}px`;
      p.marqueeEl.style.width = `${Math.max(1, mRight - mLeft)}px`;
      p.marqueeEl.style.height = `${Math.max(1, mBottom - mTop)}px`;
    }

    const hitIds = [];
    let skippedLockedInMarquee = 0;
    document.querySelectorAll(".wasm-box").forEach(box => {
      const cid = box.dataset.id;
      const ckind = box.dataset.kind;
      if (!cid || ckind === "meta" || S.draft.deletes.includes(cid)) return;
      const br = getBoxClientRect(box);
      const intersects = !(br.right < mLeft || br.left > mRight || br.bottom < mTop || br.top > mBottom);
      if (!intersects) return;
      if (S.freezeLayout && isBlockFrozenLocked(cid)) {
        skippedLockedInMarquee++;
        return;
      }
      hitIds.push(cid);
    });
    p.skippedLockedInMarquee = skippedLockedInMarquee;

    p.hitIds = getOrderedMovableIds(hitIds);
    const combined = p.additive
      ? getOrderedMovableIds([...(p.initialSelectedIds || []), ...p.hitIds])
      : p.hitIds;
    S.selectedIds = combined;
    S.selectedId = combined.length > 0 ? combined[combined.length - 1] : null;
    syncSelectionDom();
  } else if (p.mode === "drag-block") {
    const dxPx = e.clientX - p.startX;
    const dyPx = e.clientY - p.startY;
    if (!p.started && Math.hypot(dxPx, dyPx) < 5) return;
    p.started = true;

    const dxPt = dxPx * p.ptPerPx;
    let dyPt = dyPx * p.ptPerPx;
    const snapActive = isGridSnapActive();

    if (S.freezeLayout || p.useFreezeMode) {
      if (p.wasLockedOnDown) {
        if (!p.blockedLockedDrag) {
          p.blockedLockedDrag = true;
          showToast(`🔒 ${p.bid} masih terkunci! Klik 1x untuk membuka kunci (🔓) sebelum menggeser.`);
        }
        return;
      }
      if (snapActive) {
        dyPt = Math.round(dyPt / GRID_STEP_PT) * GRID_STEP_PT;
      }
      removeDropIndicators();
      p.dropTargetId = null;

      const items = Array.isArray(p.dragBoxItems) && p.dragBoxItems.length
        ? p.dragBoxItems
        : [{
            el: p.boxEl,
            bid: p.bid,
            origLeft: p.origLeft,
            origTop: p.origTop,
            origFx: 0,
            origFy: 0,
            baseDx: 0,
            baseDy: 0
          }];

      items.forEach(item => {
        item.el.classList?.add("dragging");
        item.el.classList?.remove("frozen-box");
        item.el.classList?.add("unfrozen-active");
        item.el.style.zIndex = "40";
        item.el.style.opacity = "0.86";
        const curBaseDx = Number(item.baseDx || 0);
        const curBaseDy = Number(item.baseDy || 0);
        const nextFx = Number(Math.max(-500, Math.min(500, (item.origFx || 0) + dxPt)).toFixed(1));
        const nextFy = Number(Math.max(-800, Math.min(800, (item.origFy || 0) + dyPt)).toFixed(1));
        item.nextFx = nextFx;
        item.nextFy = nextFy;
        const appliedDx = curBaseDx + (nextFx - (item.origFx || 0));
        const appliedDy = curBaseDy + (nextFy - (item.origFy || 0));
        item.el.style.transform = `translate(${appliedDx}pt, ${appliedDy}pt)`;
        const badge = item.el.querySelector?.(".wasm-box-badge");
        if (badge) {
          badge.textContent = `${item.bid} • 🔓 (${nextFx.toFixed(1)}, ${nextFy.toFixed(1)})`;
        }
      });
      return;
    }

    const fallbackInfo = getBoxSpanAndColumnInfo(p.boxEl);
    const items = Array.isArray(p.dragBoxItems) && p.dragBoxItems.length
      ? p.dragBoxItems
      : [{
          el: p.boxEl,
          origLeft: p.origLeft,
          origTop: p.origTop,
          origW: fallbackInfo.origW,
          colNum: fallbackInfo.colNum,
          isSpanPage: Boolean(p.isSpanPage || fallbackInfo.isSpanPage)
        }];
    const excludeList = Array.isArray(p.dragIds) && p.dragIds.length ? p.dragIds : [p.bid];

    if (
      !e.altKey && (
        excludeList.length > 1 ||
        Math.abs(dxPx) > 18 ||
        (Math.abs(dxPx) > Math.abs(dyPx) * 0.9 && Math.abs(dxPx) >= 8) ||
        Math.abs(dyPt) > 70
      )
    ) {
      p.dragModeLocked = "reorder";
    }

    const isNudgeMode = !(S.freezeLayout || p.useFreezeMode) && (
      Boolean(e.altKey) || (
        excludeList.length === 1 &&
        p.dragModeLocked !== "reorder" &&
        Math.abs(dyPx) >= Math.abs(dxPx)
      )
    );

    if (isNudgeMode) {
      p.nudgeApplied = true;
      removeDropIndicators();
      p.dropTargetId = null;

      const rawTargetAbove = (p.origSpacingAbove ?? 0) + dyPt;
      const nextAbove = snapActive
        ? Math.max(-44, Math.min(132, Math.round(rawTargetAbove / GRID_STEP_PT) * GRID_STEP_PT))
        : Number(Math.max(-44, Math.min(132, rawTargetAbove)).toFixed(1));
      p.nextSpacingAbove = nextAbove;
      const visualDeltaY = Number((nextAbove - (p.serverSpacingAbove ?? 0)).toFixed(1));

      const stepDiff = Number((nextAbove - (p.origSpacingAbove ?? 0)).toFixed(1));
      const stepLabel = `${stepDiff >= 0 ? "+" : ""}${stepDiff}pt`;
      const aboveLabel = `${nextAbove >= 0 ? "+" : ""}${nextAbove}pt`;

      items.forEach(item => {
        item.el.classList?.add("dragging");
        item.el.style.zIndex = "40";
        item.el.style.opacity = "0.86";
        item.el.style.left = `${item.origLeft}pt`;
        item.el.style.top = `${item.origTop}pt`;
        item.el.style.transform = `translateY(${visualDeltaY}pt)`;
        const badge = item.el.querySelector?.(".wasm-box-badge");
        if (badge) {
          badge.textContent = `${p.bid} • ↕ Nudge ${stepLabel} (Spasi Atas: ${aboveLabel})`;
        }
      });
      return;
    }

    if (p.nudgeApplied) {
      p.nudgeApplied = false;
      const origShift = Number(((p.origSpacingAbove ?? 0) - (p.serverSpacingAbove ?? 0)).toFixed(1));
      const origTransform = Math.abs(origShift) > 0.05 ? `translateY(${origShift}pt)` : "";
      items.forEach(item => {
        item.el.style.transform = origTransform;
      });
    }

    items.forEach(item => {
      item.el.classList?.add("dragging");
      item.el.style.zIndex = "40";
      item.el.style.opacity = "0.86";
      const rawLeft = item.origLeft + dxPt;
      const rawTop = item.origTop + dyPt;
      const nextLeft = item.isSpanPage
        ? Math.max(0, Math.min(PAGE_WIDTH_PT - Math.min(item.origW || PAGE_SPAN_WIDTH_PT, PAGE_WIDTH_PT), rawLeft))
        : clampXToColumn(rawLeft, item.origW || COL_WIDTH_PT, item.colNum || (item.origLeft < 295 ? 1 : 2));
      const nextTop = snapActive ? snapYToGrid(rawTop) : rawTop;
      item.el.style.left = `${nextLeft.toFixed(1)}pt`;
      item.el.style.top = `${nextTop.toFixed(1)}pt`;
    });

    removeDropIndicators();
    const hit = findDropTargetAtClientPoint(e.clientX, e.clientY, excludeList, { isSpanPage: p.isSpanPage });
    if (hit) {
      p.dropTargetId = hit.targetId;
      p.dropPos = hit.pos;
      p.floatPlacement = (excludeList.length === 1 && (p.kind === "figure" || p.kind === "table"))
        ? (hit.relYPt < 155 ? "top" : (hit.relYPt > 690 ? "bottom" : "auto"))
        : null;

      const line = document.createElement("div");
      line.className = "drop-indicator-line";
      const floatInfo = p.floatPlacement && p.floatPlacement !== "auto" ? ` [${p.floatPlacement.toUpperCase()}]` : "";
      const dragLabel = excludeList.length > 1
        ? `Pindah ${excludeList.length} objek (${excludeList.join(", ")}) `
        : "";
      line.dataset.label = `${dragLabel}${hit.pos === "before" ? "▲ Sebelum" : "▼ Sesudah"} ${hit.targetId}${floatInfo}`;
      line.style.cssText = `left:${hit.lineX}pt;width:${hit.lineW}pt;top:${hit.lineY}pt;`;
      hit.sheet.querySelector(".wasm-overlay-layer")?.appendChild(line);
    }
  } else if (p.mode === "resize-box") {
    const dxPt = (e.clientX - p.startX) * p.ptPerPx;
    const dyPt = (e.clientY - p.startY) * p.ptPerPx;
    let rawW, rawH, newW, newH;

    if (p.isCorner) {
      // Proportional Scaling (Aspect Ratio Lock) dari titik sudut dengan sudut lawan terkunci
      const signX = p.dir.includes("e") ? 1 : -1;
      const signY = p.dir.includes("s") ? 1 : -1;
      const diagSq = (p.origW * p.origW) + (p.origH * p.origH);
      const scale = Math.max(0.35, Math.min(2.2, 1 + ((signX * dxPt * p.origW) + (signY * dyPt * p.origH)) / diagSq));
      rawW = Math.max(90, Math.min(442.2, p.origW * scale));
      rawH = Math.max(18, rawW / p.aspect);
    } else if (p.dir === "e" || p.dir === "w") {
      const deltaW = p.dir === "e" ? dxPt : -dxPt;
      rawW = Math.max(90, Math.min(442.2, p.origW + deltaW));
      rawH = Math.max(18, rawW / p.aspect);
    } else {
      const deltaH = p.dir === "s" ? dyPt : -dyPt;
      const targetH = Math.max(18, p.origH + deltaH);
      rawW = Math.max(90, Math.min(442.2, targetH * p.aspect));
      rawH = Math.max(18, rawW / p.aspect);
    }

    if (isGridSnapActive()) {
      const origBottom = p.origTop + p.origH;
      if (p.dir.includes("n")) {
        const snappedTop = snapYToGrid(origBottom - rawH);
        newH = snapHeightToGrid(origBottom - snappedTop, 11);
      } else if (p.dir === "e" || p.dir === "w") {
        newH = snapHeightToGrid(rawH, 11);
      } else {
        const snappedBottom = snapYToGrid(p.origTop + rawH);
        newH = snapHeightToGrid(snappedBottom - p.origTop, 11);
      }
      newW = Math.max(90, Math.min(442.2, newH * p.aspect));
      if (Math.abs(newW - newH * p.aspect) > 0.01) {
        newH = snapHeightToGrid(newW / p.aspect, 11);
      }
      if (p.dir.includes("n")) {
        p.boxEl.style.top = `${snapYToGrid(origBottom - newH).toFixed(1)}pt`;
      } else if (p.isCorner) {
        p.boxEl.style.top = `${p.origTop.toFixed(1)}pt`;
      }
      if (p.dir.includes("w")) {
        p.boxEl.style.left = `${(p.origLeft + p.origW - newW).toFixed(1)}pt`;
      } else if (p.isCorner) {
        p.boxEl.style.left = `${p.origLeft.toFixed(1)}pt`;
      }
    } else {
      newW = rawW;
      newH = rawH;
      if (p.isCorner) {
        const newLeft = p.dir.includes("w") ? (p.origLeft + p.origW - newW) : p.origLeft;
        const newTop = p.dir.includes("n") ? (p.origTop + p.origH - newH) : p.origTop;
        p.boxEl.style.left = `${newLeft.toFixed(1)}pt`;
        p.boxEl.style.top = `${newTop.toFixed(1)}pt`;
      } else if (p.dir === "w") {
        p.boxEl.style.left = `${(p.origLeft + p.origW - newW).toFixed(1)}pt`;
      } else if (p.dir === "n") {
        p.boxEl.style.top = `${(p.origTop + p.origH - newH).toFixed(1)}pt`;
      }
    }

    const newSpan = newW > 295 ? "page" : "column";
    const rawPct = newSpan === p.origSpan
      ? (p.initialPct * (newW / p.origW))
      : ((newW / (newSpan === "page" ? 442.2 : 213.6)) * 100);
    const newPct = Math.max(50, Math.min(130, Math.round(rawPct)));

    p.boxEl.style.width = `${newW.toFixed(1)}pt`;
    p.boxEl.style.height = `${newH.toFixed(1)}pt`;
    p.newPct = newPct;
    p.newSpan = newSpan;

    const skalaEl = document.getElementById("prop-skala");
    const skalaVal = document.getElementById("prop-skala-val");
    const penuhEl = document.getElementById("prop-penuh");
    if (skalaEl) skalaEl.value = String(newPct);
    if (skalaVal) skalaVal.textContent = `${newPct}%`;
    if (penuhEl) penuhEl.checked = (newSpan === "page");

    const badge = p.boxEl.querySelector(".wasm-box-badge");
    if (badge) {
      badge.textContent = `${p.bid} • ${p.isCorner ? "🔒 Proporsional" : "Skala"} ${newPct}% (${newSpan === "page" ? "2 Kolom" : "1 Kolom"})`;
    }
  } else if (p.mode === "resize-text") {
    const dxPt = (e.clientX - p.startX) * p.ptPerPx;
    const dyPt = (e.clientY - p.startY) * p.ptPerPx;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const badge = p.boxEl.querySelector(".wasm-box-badge");

    if (p.inFreezeMode) {
      let newW = p.origW;
      let newH = p.origH;
      let newLeft = p.origLeft;
      let newTop = p.origTop;
      let nextFx = p.origFx || 0;
      let nextFy = p.origFy || 0;
      let nextFreezeW = p.origFreezeW > 1 ? p.origFreezeW : p.origW;

      if (p.dir.includes("e")) {
        newW = clamp(p.origW + dxPt, 90, PAGE_SPAN_WIDTH_PT);
        nextFreezeW = Number(newW.toFixed(1));
      } else if (p.dir.includes("w")) {
        newW = clamp(p.origW - dxPt, 90, PAGE_SPAN_WIDTH_PT);
        const shiftX = p.origW - newW;
        newLeft = p.origLeft + shiftX;
        nextFx = Number(clamp((p.origFx || 0) + shiftX, -500, 500).toFixed(1));
        nextFreezeW = Number(newW.toFixed(1));
      }

      if (p.dir.includes("s")) {
        const rawH = Math.max(11, p.origH + dyPt);
        if (isGridSnapActive()) {
          const snappedBottom = snapYToGrid(p.origTop + rawH);
          newH = snapHeightToGrid(snappedBottom - p.origTop, 11);
        } else {
          newH = rawH;
        }
      } else if (p.dir.includes("n")) {
        const origBottom = p.origTop + p.origH;
        const rawH = Math.max(11, p.origH - dyPt);
        if (isGridSnapActive()) {
          const snappedTop = snapYToGrid(origBottom - rawH);
          newH = snapHeightToGrid(origBottom - snappedTop, 11);
        } else {
          newH = rawH;
        }
        const shiftY = p.origH - newH;
        newTop = p.origTop + shiftY;
        nextFy = Number(clamp((p.origFy || 0) + shiftY, -800, 800).toFixed(1));
      }

      p.boxEl.style.left = `${newLeft.toFixed(1)}pt`;
      p.boxEl.style.top = `${newTop.toFixed(1)}pt`;
      p.boxEl.style.width = `${newW.toFixed(1)}pt`;
      p.boxEl.style.height = `${newH.toFixed(1)}pt`;

      const deltaH = newH - p.origH;
      const nextLeading = Number(clamp((p.origLeading || 0) + (deltaH / Math.max(1, (p.estLines || 1) - 1)), -3.5, 12.0).toFixed(2));
      let nextTrack = p.origTracking || 0;
      if ((p.estLines || 1) === 1 || Math.abs(deltaH) > 5.5) {
        nextTrack = Number(clamp((p.origTracking || 0) + clamp(deltaH / 160, -0.4, 0.4), -0.4, 0.4).toFixed(3));
      }

      const patch = {
        frozen: false,
        unlocked_in_freeze: true,
        freeze_w: Number(nextFreezeW.toFixed(1)),
        freeze_x: nextFx,
        freeze_y: nextFy,
        leading: nextLeading,
        tracking: nextTrack
      };
      if (p.origSlotH > 1) patch.freeze_slot_h = p.origSlotH;
      p.textStylePatch = patch;
      if (badge) {
        badge.textContent = `${p.bid} • 🔓 Resize ${newW.toFixed(0)}×${newH.toFixed(0)}pt`;
      }
      return;
    }

    if (p.dir === "n") {
      // Tarik gagang atas: ubah spacing_above (kelipatan 11pt)
      const stepLines = Math.round(dyPt / 11);
      const nextAbove = clamp(Math.round((p.origSpacingAbove + stepLines * 11) / 11) * 11, -22, 66);
      if (isGridSnapActive()) {
        const appliedShift = nextAbove - p.origSpacingAbove;
        const snappedTop = snapYToGrid(p.origTop + appliedShift);
        const snappedH = snapHeightToGrid(p.origH - appliedShift, 11);
        p.boxEl.style.top = `${snappedTop.toFixed(1)}pt`;
        p.boxEl.style.height = `${snappedH.toFixed(1)}pt`;
      } else {
        const rawShift = clamp(dyPt, -22 - p.origSpacingAbove, 66 - p.origSpacingAbove);
        p.boxEl.style.top = `${(p.origTop + rawShift).toFixed(1)}pt`;
        p.boxEl.style.height = `${Math.max(11, p.origH - rawShift * 0.25).toFixed(1)}pt`;
      }
      p.textStylePatch = { spacing_above: nextAbove };
      if (badge) badge.textContent = `${p.bid} • Spasi Atas ${nextAbove >= 0 ? "+" : ""}${nextAbove}pt`;
    } else if (p.dir === "e" || p.dir === "w") {
      // Tarik gagang samping: sesuaikan tracking agar teks merenggang / merapat mengalir
      const signedDx = p.dir === "e" ? dxPt : -dxPt;
      const nextTrack = Number(clamp(p.origTracking + (signedDx / 120), -0.4, 0.4).toFixed(3));
      const previewW = clamp(p.origW + signedDx * 0.35, 175, 228);
      p.boxEl.style.width = `${previewW.toFixed(1)}pt`;
      p.textStylePatch = { tracking: nextTrack };
      if (badge) badge.textContent = `${p.bid} • Aliran Teks (Tracking ${nextTrack >= 0 ? "+" : ""}${nextTrack.toFixed(2)}pt)`;
    } else {
      // Tarik gagang bawah / sudut: panjangkan atau pendekkan blok teks secara mengalir (tracking + spacing_below grid 11pt)
      const deltaPt = p.dir.includes("n") ? -dyPt : dyPt;
      const rawH = Math.max(11, p.origH + deltaPt);
      let newH;
      if (isGridSnapActive()) {
        const snappedBottom = snapYToGrid(p.origTop + rawH);
        newH = snapHeightToGrid(snappedBottom - p.origTop, 11);
      } else {
        newH = rawH;
      }
      p.boxEl.style.height = `${newH.toFixed(1)}pt`;
      const deltaLines = Math.round((newH - p.origH) / 11);

      let nextBelow = p.origSpacingBelow;
      let nextTrack = p.origTracking;

      if (deltaLines < 0) {
        let rem = deltaLines;
        if (nextBelow > 0) {
          const reduceLines = Math.min(Math.round(nextBelow / 11), -rem);
          nextBelow -= reduceLines * 11;
          rem += reduceLines;
        }
        if (rem < 0 && p.textLen >= 40) {
          const trackRoomLines = Math.floor((nextTrack - (-0.4)) / 0.18 + 0.001);
          const useTrackLines = Math.min(trackRoomLines, -rem);
          nextTrack = Number(clamp(nextTrack - useTrackLines * 0.18, -0.4, 0.4).toFixed(3));
          rem += useTrackLines;
        }
        if (rem < 0) {
          nextBelow = clamp(Math.round((nextBelow + rem * 11) / 11) * 11, -22, 66);
        }
      } else if (deltaLines > 0) {
        let rem = deltaLines;
        if (nextBelow < 0) {
          const addLines = Math.min(Math.round(-nextBelow / 11), rem);
          nextBelow += addLines * 11;
          rem -= addLines;
        }
        if (rem > 0 && nextTrack < 0) {
          const relaxLines = Math.min(Math.ceil((-nextTrack) / 0.18), rem);
          nextTrack = Number(clamp(nextTrack + relaxLines * 0.18, -0.4, 0.4).toFixed(3));
          rem -= relaxLines;
        }
        if (rem > 0) {
          if (p.textLen >= 65 && nextTrack < 0.36) {
            nextTrack = Number(clamp(nextTrack + Math.min(2, rem) * 0.14, -0.4, 0.4).toFixed(3));
          }
          nextBelow = clamp(Math.round((nextBelow + rem * 11) / 11) * 11, -22, 66);
        }
      }

      p.textStylePatch = { spacing_below: nextBelow, tracking: nextTrack };
      if (badge) {
        const sign = deltaLines > 0 ? `+${deltaLines}` : String(deltaLines);
        badge.textContent = `${p.bid} • ${sign} baris (Spasi ${nextBelow >= 0 ? "+" : ""}${nextBelow}pt • Track ${nextTrack >= 0 ? "+" : ""}${nextTrack.toFixed(2)}pt)`;
      }
    }
  } else if (p.mode === "col-handle") {
    const dyPt = (e.clientY - p.startY) * p.ptPerPx;
    if (isGridSnapActive()) {
      const newBaris = Math.max(-2, Math.min(2, p.origKaki + Math.round(-dyPt / 11)));
      p.newBaris = newBaris;
      if (p.colBar) p.colBar.style.top = `${(762.4 - (newBaris * 11)).toFixed(2)}pt`;
    } else {
      const rawBaris = Math.max(-2, Math.min(2, p.origKaki + (-dyPt / 11)));
      p.newBaris = Math.round(rawBaris);
      if (p.colBar) p.colBar.style.top = `${(762.4 - (rawBaris * 11)).toFixed(2)}pt`;
    }
  } else if (p.mode === "header-handle") {
    const dyPt = (e.clientY - p.startY) * p.ptPerPx;
    if (isGridSnapActive()) {
      const newBaris = Math.max(-2, Math.min(2, p.origKepala + Math.round(dyPt / 11)));
      p.newBaris = newBaris;
      if (p.headerBar) p.headerBar.style.top = `calc(${(p.baseHeaderTop + (newBaris * 11)).toFixed(2)}pt - 9px)`;
    } else {
      const rawBaris = Math.max(-2, Math.min(2, p.origKepala + (dyPt / 11)));
      p.newBaris = Math.round(rawBaris);
      if (p.headerBar) p.headerBar.style.top = `calc(${(p.baseHeaderTop + (rawBaris * 11)).toFixed(2)}pt - 9px)`;
    }
  }
}

function onPointerUp() {
  if (window.EditorState.cropDrag) {
    window.EditorState.cropDrag = null;
    return;
  }
  const S = window.EditorState;
  const p = S.pointer;
  if (!p) return;
  S.pointer = null;
  removeDropIndicators();

  if (p.mode === "marquee") {
    if (p.marqueeEl) p.marqueeEl.remove();
    if (!p.started) {
      if (!p.additive) setSelection([], null, null, false);
    } else {
      setSelection(S.selectedIds, S.selectedId, null, false);
      if (S.freezeLayout && (!S.selectedIds || S.selectedIds.length === 0) && (p.skippedLockedInMarquee || 0) > 0 && !p.additive) {
        showToast("🔒 Blok di area tersebut masih terkunci. Klik 1x untuk membuka kunci (🔓) sebelum memilih & menggeser bersamaan.");
      }
    }
    return;
  }

  if (p.mode === "drag-block") {
    const items = Array.isArray(p.dragBoxItems) && p.dragBoxItems.length
      ? p.dragBoxItems
      : [{ el: p.boxEl, origLeft: p.origLeft, origTop: p.origTop }];
    items.forEach(item => {
      item.el.classList?.remove("dragging");
      item.el.style.opacity = "";
      item.el.style.zIndex = "";
    });

    if (S.freezeLayout || p.useFreezeMode) {
      if (p.blockedLockedDrag) {
        setSelection([p.bid], p.bid, p.page, false);
        return;
      }
      if (p.started) {
        if (!S._freezeUnlockedIds) S._freezeUnlockedIds = {};
        items.forEach(item => {
          if (item.bid) S._freezeUnlockedIds[item.bid] = true;
          const nextFx = item.nextFx !== undefined ? item.nextFx : (item.origFx || 0);
          const nextFy = item.nextFy !== undefined ? item.nextFy : (item.origFy || 0);
          const movePatch = { frozen: false, unlocked_in_freeze: true, freeze_x: nextFx, freeze_y: nextFy };
          const slotH = getFreezeSlotHeight(item.bid, 0);
          if (slotH > 1) movePatch.freeze_slot_h = slotH;
          recordEditDraft(item.bid, { style: movePatch });
        });
        const movedIds = Array.from(new Set(items.map(it => it.bid).filter(Boolean)));
        rebuildAllOverlays();
        setSelection(movedIds.length ? movedIds : [p.bid], p.bid, p.page, false);
        refreshDraftUi();
        scheduleAutoSave();
        showToast(
          movedIds.length > 1
            ? `🔓 ${movedIds.length} objek digeser (blok terkunci tetap) — merender otomatis...`
            : `🔓 ${p.bid} digeser: (${(items[0].nextFx ?? items[0].origFx ?? 0).toFixed(1)}, ${(items[0].nextFy ?? items[0].origFy ?? 0).toFixed(1)}) — merender otomatis...`
        );
      } else {
        if (p.toggleOffOnClick) {
          const next = (S.selectedIds || []).filter(id => id !== p.bid);
          setSelection(next, next[next.length - 1] || null, p.page, false);
          return;
        }
        if (p.additive) {
          return;
        }
        const currentlyLocked = isBlockFrozenLocked(p.bid);
        const nextLocked = !currentlyLocked;
        if (!S._freezeUnlockedIds) S._freezeUnlockedIds = {};
        if (nextLocked) {
          delete S._freezeUnlockedIds[p.bid];
        } else {
          S._freezeUnlockedIds[p.bid] = true;
        }
        if (S.draft.edits[p.bid]?.style) {
          S.draft.edits[p.bid].style.frozen = nextLocked;
          S.draft.edits[p.bid].style.unlocked_in_freeze = !nextLocked;
          persistLocalDraft();
        }
        rebuildAllOverlays();
        setSelection([p.bid], p.bid, p.page, false);
        refreshDraftUi();
        showToast(nextLocked
          ? `🔒 ${p.bid} dikunci kembali (posisi terjaga)`
          : `🔓 ${p.bid} dibuka kuncinya — siap digeser!`);
      }
      return;
    }

    if (p.started && p.nudgeApplied) {
      const nextAbove = Number((p.nextSpacingAbove ?? p.origSpacingAbove ?? 0).toFixed(1));
      const changed = Math.abs(nextAbove - (p.origSpacingAbove ?? 0)) > 0.05;
      const visualDeltaY = Number((nextAbove - (p.serverSpacingAbove ?? 0)).toFixed(1));
      items.forEach(item => {
        item.el.style.left = `${item.origLeft}pt`;
        item.el.style.top = `${item.origTop}pt`;
        item.el.style.transform = Math.abs(visualDeltaY) > 0.05 ? `translateY(${visualDeltaY}pt)` : "";
      });
      if (changed) {
        recordEditDraft(p.bid, { style: { spacing_above: nextAbove } });
        selectBlockById(p.bid, p.page, false);
        showToast(`↕️ Spasi atas ${p.bid}: ${nextAbove >= 0 ? "+" : ""}${nextAbove}pt`);
        scheduleAutoSave();
      } else {
        rebuildAllOverlays();
      }
      return;
    }

    const orderedIds = getOrderedMovableIds(
      Array.isArray(p.dragIds) && p.dragIds.length ? p.dragIds : [p.bid]
    ).filter(id => id !== p.dropTargetId);

    if (p.started && p.dropTargetId && orderedIds.length > 0 && !orderedIds.includes(p.dropTargetId)) {
      const mv = {
        block_ids: orderedIds,
        target_id: p.dropTargetId,
        position: p.dropPos || "after"
      };
      if (orderedIds.length === 1 && p.floatPlacement && p.floatPlacement !== "auto") {
        mv.placement = p.floatPlacement;
      }
      S.draft.moves.push(mv);
      if (orderedIds.length === 1 && p.floatPlacement) {
        recordEditDraft(orderedIds[0], { style: { placement: p.floatPlacement } });
      } else {
        persistLocalDraft();
      }
      applyLocalMoveToBlocks(orderedIds, p.dropTargetId, p.dropPos || "after");
      rebuildAllOverlays();
      renderObjectNavigator();
      setSelection(orderedIds, p.bid, p.page, false);
      showToast(
        orderedIds.length > 1
          ? `📦 ${orderedIds.length} objek dipindah ${p.dropPos === "before" ? "sebelum" : "sesudah"} ${p.dropTargetId}`
          : `Blok ${orderedIds[0]} dipindah ${p.dropPos === "before" ? "sebelum" : "sesudah"} ${p.dropTargetId}`
      );
      scheduleAutoSave();
    } else {
      const origShift = Number(((p.origSpacingAbove ?? 0) - (p.serverSpacingAbove ?? 0)).toFixed(1));
      const origTransform = Math.abs(origShift) > 0.05 ? `translateY(${origShift}pt)` : "";
      items.forEach(item => {
        item.el.style.left = `${item.origLeft}pt`;
        item.el.style.top = `${item.origTop}pt`;
        item.el.style.transform = origTransform;
      });
      if (!p.started) {
        if (p.toggleOffOnClick) {
          const next = (S.selectedIds || []).filter(id => id !== p.bid);
          setSelection(next, next[next.length - 1] || null, p.page, false);
        } else if (p.collapseToSingleOnClick) {
          setSelection([p.bid], p.bid, p.page, false);
        }
      }
    }
  } else if (p.mode === "resize-box" && p.newPct !== undefined) {
    const stylePatch = { width_pct: p.newPct, span: p.newSpan };
    if (p.kind === "table") {
      stylePatch.font_size = Number(Math.max(7.5, Math.min(13.5, 11 * (p.newPct / 100))).toFixed(2));
      stylePatch.cell_pad = Number(Math.max(1.5, Math.min(7.0, 4 * (p.newPct / 100))).toFixed(2));
    }
    if (p.inFreezeMode) {
      if (!S._freezeUnlockedIds) S._freezeUnlockedIds = {};
      S._freezeUnlockedIds[p.bid] = true;
      stylePatch.frozen = false;
      stylePatch.unlocked_in_freeze = true;
      if (p.origSlotH > 1) stylePatch.freeze_slot_h = p.origSlotH;
    }
    recordEditDraft(p.bid, { style: stylePatch });
    selectBlockById(p.bid, parseInt(p.boxEl.dataset.page, 10) || 1, false);
    showToast(`Ukuran ${p.bid}: ${p.newPct}% (${p.newSpan === "page" ? "2 Kolom" : "1 Kolom"})`);
    scheduleAutoSave();
  } else if (p.mode === "resize-text") {
    const patch = p.textStylePatch;
    if (p.inFreezeMode) {
      const changed = patch && (
        Math.abs((patch.leading ?? p.origLeading) - p.origLeading) > 0.01 ||
        Math.abs((patch.tracking ?? p.origTracking) - p.origTracking) > 0.005 ||
        Math.abs((patch.freeze_w ?? p.origFreezeW) - (p.origFreezeW > 1 ? p.origFreezeW : p.origW)) > 0.5 ||
        Math.abs((patch.freeze_x ?? p.origFx) - p.origFx) > 0.05 ||
        Math.abs((patch.freeze_y ?? p.origFy) - p.origFy) > 0.05
      );
      if (changed) {
        if (!S._freezeUnlockedIds) S._freezeUnlockedIds = {};
        S._freezeUnlockedIds[p.bid] = true;
        recordEditDraft(p.bid, { style: patch });
        selectBlockById(p.bid, p.page, false);
        showToast(`🔓 Ukuran teks ${p.bid} diperbarui (blok terkunci lain tetap) — merender otomatis...`);
        scheduleAutoSave();
      } else {
        p.boxEl.style.left = `${p.origLeft}pt`;
        p.boxEl.style.top = `${p.origTop}pt`;
        p.boxEl.style.width = `${p.origW}pt`;
        p.boxEl.style.height = `${p.origH}pt`;
        rebuildAllOverlays();
      }
      return;
    }
    p.boxEl.style.width = `${p.origW}pt`;
    const changed = patch && (
      (patch.spacing_above !== undefined && patch.spacing_above !== p.origSpacingAbove) ||
      (patch.spacing_below !== undefined && patch.spacing_below !== p.origSpacingBelow) ||
      (patch.tracking !== undefined && Math.abs(patch.tracking - p.origTracking) > 0.005)
    );
    if (changed) {
      recordEditDraft(p.bid, { style: patch });
      selectBlockById(p.bid, p.page, false);
      showToast(` Ukuran & aliran teks ${p.bid} diperbarui`);
      scheduleAutoSave();
    } else {
      p.boxEl.style.top = `${p.origTop}pt`;
      p.boxEl.style.height = `${p.origH}pt`;
      rebuildAllOverlays();
    }
  } else if (p.mode === "col-handle") {
    if (p.newBaris !== undefined && p.newBaris !== p.origKaki) {
      S.draft.kaki_naik[p.pageNum] = p.newBaris;
      persistLocalDraft();
      rebuildAllOverlays();
      selectBlockById(S.selectedId, p.pageNum, false);
      showToast(`Margin Bawah Kolom Hlm ${p.pageNum}: ${p.newBaris > 0 ? "+" : ""}${p.newBaris * 11}pt`);
      scheduleAutoSave();
    } else if (p.colBar) {
      p.colBar.style.top = `${(762.4 - (p.origKaki * 11)).toFixed(2)}pt`;
    }
  } else if (p.mode === "header-handle") {
    if (p.newBaris !== undefined && p.newBaris !== p.origKepala) {
      S.draft.header_naik[p.pageNum] = p.newBaris;
      persistLocalDraft();
      rebuildAllOverlays();
      selectBlockById(S.selectedId, p.pageNum, false);
      showToast(`Margin Atas Kolom Hlm ${p.pageNum}: ${p.newBaris > 0 ? "+" : ""}${p.newBaris * 11}pt`);
      scheduleAutoSave();
    } else if (p.headerBar) {
      p.headerBar.style.top = `calc(${(p.baseHeaderTop + (p.origKepala * 11)).toFixed(2)}pt - 9px)`;
    }
  }
}

// ==================== 6. SIMPAN DRAFT KE SERVER (LIVE RE-RENDER & AUTO-SAVE) ====================
async function saveWorkspaceToServer(opts = {}) {
  const isBg = !!opts.background;
  cancelAutoSave();
  const S = window.EditorState;
  if (!S.articleId) {
    if (!isBg) showToast("Pilih artikel terlebih dahulu");
    return false;
  }
  if (_activeSavePromise) {
    if (isBg) {
      scheduleAutoSave(900);
      return false;
    }
    await _activeSavePromise;
    if (draftChangeCount() === 0) {
      refreshDraftUi();
      return true;
    }
  }
  if (isBg && draftChangeCount() === 0) {
    refreshDraftUi();
    return true;
  }
  if (S.serverBusy) {
    if (isBg) scheduleAutoSave(900);
    return false;
  }

  const runSave = async () => {
    // Snapshot draft yang dikirim agar perubahan baru selama request berjalan tidak hilang
    const prevSelectedId = S.selectedId;
    const prevSelectedIds = Array.isArray(S.selectedIds) ? [...S.selectedIds] : (S.selectedId ? [S.selectedId] : []);
    const sentSnapshot = JSON.parse(JSON.stringify(S.draft));
    if (isBg) {
      setAutoRenderIndicator(true, "Merender ulang PDF...");
    } else {
      setServerLoading(true, "⏳ Menyimpan Draft ke Typst & Merender Ulang PDF...");
    }
    setDraftStatus("menyimpan", isBg ? "Merender..." : "Menyimpan...");

    S._lastSaveResult = null;
    try {
      const payload = {
        artikel: S.articleId,
        edits: Object.values(sentSnapshot.edits),
        moves: sentSnapshot.moves,
        deletes: sentSnapshot.deletes,
        splits: Array.isArray(sentSnapshot.splits) ? sentSnapshot.splits : [],
        crops: Object.values(sentSnapshot.crops),
        kaki_naik: sentSnapshot.kaki_naik,
        header_naik: sentSnapshot.header_naik
      };
      const res = await apiFetch("save_workspace", {}, payload);
      S._lastSaveResult = res;

      // Bersihkan hanya entri draft yang tidak berubah lagi sejak snapshot dikirim
      const cur = S.draft;
      Object.keys(sentSnapshot.edits).forEach(k => {
        if (JSON.stringify(cur.edits[k]) === JSON.stringify(sentSnapshot.edits[k])) delete cur.edits[k];
      });
      cur.moves.splice(0, sentSnapshot.moves.length);
      sentSnapshot.deletes.forEach(id => {
        const idx = cur.deletes.indexOf(id);
        if (idx >= 0) cur.deletes.splice(idx, 1);
      });
      if (Array.isArray(cur.splits) && Array.isArray(sentSnapshot.splits)) {
        cur.splits.splice(0, sentSnapshot.splits.length);
      }
      Object.keys(sentSnapshot.crops).forEach(k => {
        if (JSON.stringify(cur.crops[k]) === JSON.stringify(sentSnapshot.crops[k])) delete cur.crops[k];
      });
      Object.keys(sentSnapshot.kaki_naik).forEach(k => {
        if (cur.kaki_naik[k] === sentSnapshot.kaki_naik[k]) delete cur.kaki_naik[k];
      });
      Object.keys(sentSnapshot.header_naik).forEach(k => {
        if (cur.header_naik[k] === sentSnapshot.header_naik[k]) delete cur.header_naik[k];
      });

      persistLocalDraft();
      const preApplySelectedIds = Array.isArray(S.selectedIds) ? [...S.selectedIds] : [];
      const preApplySelectedId = S.selectedId;
      await applyWorkspaceState(res, true);
      const userChangedSelection = JSON.stringify(preApplySelectedIds) !== JSON.stringify(prevSelectedIds) && preApplySelectedIds.length > 0;
      const baseSel = userChangedSelection ? preApplySelectedIds : prevSelectedIds;
      const basePrimary = userChangedSelection ? preApplySelectedId : prevSelectedId;
      const validIds = baseSel.filter(id => S.blocks.some(b => b.id === id));
      if (validIds.length > 0) {
        setSelection(validIds, validIds.includes(basePrimary) ? basePrimary : validIds[0], null, false);
      } else if (S.selectedId) {
        selectBlockById(S.selectedId, null, false);
      }
      if (!isBg) showToast("✅ Perubahan berhasil disimpan & PDF dirender ulang!");
      return true;
    } catch (err) {
      console.error("saveWorkspace error:", err);
      showToast("Gagal menyimpan perubahan: " + err.message, 4200);
      setDraftStatus("kotor", "Gagal Simpan");
      return false;
    } finally {
      _activeSavePromise = null;
      if (isBg) setAutoRenderIndicator(false);
      else setServerLoading(false);
      if (draftChangeCount() > 0) scheduleAutoSave(AUTO_SAVE_DELAY_MS);
    }
  };

  _activeSavePromise = runSave();
  try {
    return await _activeSavePromise;
  } finally {
    _activeSavePromise = null;
  }
}

function removeCutGuideLine() {
  document.querySelectorAll?.(".cut-guide-line")?.forEach?.(el => el.remove());
}

function setCutModeUiState() {
  const S = window.EditorState;
  const active = Boolean(S.isCutMode);
  const k = document.getElementById("kanvas-pdf");
  if (k) k.classList.toggle("cut-mode", active);
  document.getElementById("btn-cut-mode")?.classList?.toggle("btn-aktif", active);
}

function setCutMode(active) {
  const S = window.EditorState;
  const nextActive = Boolean(active);
  S.isCutMode = nextActive;
  if (!nextActive) {
    removeCutGuideLine();
  }
  setCutModeUiState();
}

function toggleCutMode() {
  const S = window.EditorState;
  if (S.isCutMode) {
    setCutMode(false);
    showToast("✂️ Mode Potong (Gunting) dimatikan.");
    return false;
  }
  setCutMode(true);
  showToast("✂️ Mode Potong AKTIF: Arahkan kursor gunting ke paragraf di kanvas & klik garis merah (Esc untuk batal).");
  return true;
}

function findTextBoxForCutEvent(e) {
  const S = window.EditorState;
  let box = e?.target?.closest ? e.target.closest(".wasm-box") : null;
  if (!box && Number.isFinite(e?.clientX) && Number.isFinite(e?.clientY)) {
    const boxes = Array.from(document.querySelectorAll?.(".wasm-box") || []);
    for (const cand of boxes) {
      const r = getBoxClientRect(cand);
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
        box = cand;
        break;
      }
    }
  }
  if (!box) return null;
  const bid = box.dataset?.id;
  const kind = box.dataset?.kind;
  if (!bid || ["meta", "figure", "table"].includes(kind)) return null;
  if ((S.draft?.deletes || []).includes(bid)) return null;
  return box;
}

function getBoxTextLinesInSeg(segEl) {
  const S = window.EditorState;
  const page = parseInt(segEl?.dataset?.page, 10) || 1;
  const boxLeftPt = parseFloat(segEl?.style?.left) || 76.54;
  const visCol = boxLeftPt < 290 ? 1 : 2;
  const colFromData = parseInt(segEl?.dataset?.column, 10);
  const pageLines = S.pageTextLines?.[page]?.[visCol] ||
    (colFromData ? S.pageTextLines?.[page]?.[colFromData] : null);
  if (!Array.isArray(pageLines) || pageLines.length === 0) return [];
  const segTopPt = parseFloat(segEl?.style?.top) || 0;
  const rect = getBoxClientRect(segEl);
  const ptPerPx = getPtPerPx(segEl);
  const segHeightPt = Math.max(1, parseFloat(segEl?.style?.height) || (rect.height * ptPerPx) || 1);
  const segBotPt = segTopPt + segHeightPt;
  return pageLines
    .filter(ln => {
      const mid = (ln.top + ln.bottom) / 2;
      return mid >= segTopPt - 2.5 && mid <= segBotPt + 2.5;
    })
    .map(ln => ({ segEl, top: ln.top, bottom: ln.bottom, mid: (ln.top + ln.bottom) / 2 }));
}

function resolveVisualCutTarget(boxEl, clientY) {
  if (!boxEl) {
    return { localRatio: 0.5, overallRatio: 0.5, snappedToEmpty: false, snappedToLines: false };
  }
  const rect = getBoxClientRect(boxEl);
  const segH = rect.height > 0 ? rect.height : 1;
  const rawLocalFrac = (clientY - rect.top) / segH;
  const clampedLocalFrac = Math.max(0.02, Math.min(0.98, rawLocalFrac));

  const bid = boxEl.dataset?.id;
  const sameSegsRaw = bid
    ? Array.from(document.querySelectorAll?.(".wasm-box") || []).filter(el => el?.dataset?.id === bid)
    : [];
  const sameSegs = (sameSegsRaw.length > 0 ? sameSegsRaw : [boxEl]).slice().sort((a, b) => {
    const pa = parseInt(a.dataset?.page, 10) || 1;
    const pb = parseInt(b.dataset?.page, 10) || 1;
    if (pa !== pb) return pa - pb;
    const ca = (parseFloat(a.style?.left) || 76.54) < 290 ? 1 : 2;
    const cb = (parseFloat(b.style?.left) || 76.54) < 290 ? 1 : 2;
    if (ca !== cb) return ca - cb;
    return (parseFloat(a.style?.top) || 0) - (parseFloat(b.style?.top) || 0);
  });

  const allLines = [];
  const curSegLines = [];
  sameSegs.forEach(segEl => {
    const lines = getBoxTextLinesInSeg(segEl);
    lines.forEach(ln => {
      const entry = {
        segEl,
        top: ln.top,
        bottom: ln.bottom,
        mid: ln.mid,
        globalIndex: allLines.length
      };
      allLines.push(entry);
      if (segEl === boxEl) curSegLines.push(entry);
    });
  });

  const ptPerPx = getPtPerPx(boxEl);
  const boxTopPt = parseFloat(boxEl.style?.top) || 0;
  const boxHeightPt = Math.max(1, parseFloat(boxEl.style?.height) || (rect.height * ptPerPx) || 1);
  const clickYPt = boxTopPt + rawLocalFrac * boxHeightPt;

  if (allLines.length > 0) {
    const totalLines = allLines.length;
    if (curSegLines.length === 0) {
      const boxIdx = sameSegs.indexOf(boxEl);
      const afterLines = sameSegs.slice(0, Math.max(0, boxIdx)).some(s => allLines.some(l => l.segEl === s));
      const overallRatio = afterLines ? 0.98 : 0.02;
      return {
        localRatio: afterLines ? 0.0 : 1.0,
        overallRatio,
        snappedToEmpty: true,
        snappedToLines: true,
        snappedYPt: null,
        totalLines
      };
    }
    if (totalLines === 1) {
      const only = curSegLines[0];
      const inEmpty = clickYPt >= only.bottom || clickYPt <= only.top;
      const snappedYPt = clickYPt >= only.bottom ? only.bottom : (clickYPt <= only.top ? only.top : clickYPt);
      const localRatio = Math.max(0.0, Math.min(1.0, (snappedYPt - boxTopPt) / boxHeightPt));
      return { localRatio, overallRatio: 0.5, snappedToEmpty: inEmpty, snappedToLines: true, snappedYPt, totalLines: 1 };
    }

    const firstLine = curSegLines[0];
    const lastLine = curSegLines[curSegLines.length - 1];
    let snappedYPt;
    let overallRatio;
    let snappedToEmpty = false;

    if (clickYPt >= lastLine.bottom) {
      snappedYPt = lastLine.bottom;
      const isLastBlockSeg = (lastLine.globalIndex === totalLines - 1);
      overallRatio = isLastBlockSeg
        ? 0.98
        : Math.max(0.02, Math.min(0.98, (lastLine.globalIndex + 1) / totalLines));
      snappedToEmpty = true;
    } else if (clickYPt <= firstLine.top) {
      snappedYPt = firstLine.top;
      overallRatio = firstLine.globalIndex === 0
        ? Math.max(0.02, Math.min(0.98, 1 / totalLines))
        : Math.max(0.02, Math.min(0.98, firstLine.globalIndex / totalLines));
      snappedToEmpty = true;
    } else {
      const boundaries = [];
      if (firstLine.globalIndex > 0) {
        boundaries.push({ yPt: firstLine.top, linesBefore: firstLine.globalIndex });
      }
      curSegLines.forEach(ln => {
        boundaries.push({ yPt: ln.bottom, linesBefore: ln.globalIndex + 1 });
      });
      let best = boundaries[0];
      let bestDist = Infinity;
      for (const b of boundaries) {
        const d = Math.abs(clickYPt - b.yPt);
        if (d < bestDist) {
          bestDist = d;
          best = b;
        }
      }
      snappedYPt = best.yPt;
      const rawR = best.linesBefore >= totalLines ? 0.98 : (best.linesBefore / totalLines);
      overallRatio = Math.max(0.02, Math.min(0.98, rawR));
    }

    const localRatio = Math.max(0.0, Math.min(1.0, (snappedYPt - boxTopPt) / boxHeightPt));
    return {
      localRatio,
      overallRatio: Number(overallRatio.toFixed(4)),
      snappedToEmpty,
      snappedToLines: true,
      snappedYPt,
      totalLines
    };
  }

  // Fallback jika baris PDF belum diekstrak
  if (sameSegs.length > 1) {
    let totalH = 0;
    let cumBefore = 0;
    let found = false;
    for (const segEl of sameSegs) {
      const sr = getBoxClientRect(segEl);
      const h = Math.max(1, parseFloat(segEl.style?.height) || sr.height || 1);
      if (segEl === boxEl) found = true;
      else if (!found) cumBefore += h;
      totalH += h;
    }
    if (found && totalH > 0) {
      const curH = Math.max(1, parseFloat(boxEl.style?.height) || rect.height || 1);
      const ratio = (cumBefore + clampedLocalFrac * curH) / totalH;
      return {
        localRatio: clampedLocalFrac,
        overallRatio: Number(Math.max(0.02, Math.min(0.98, ratio)).toFixed(4)),
        snappedToEmpty: false,
        snappedToLines: false,
        snappedYPt: Number((boxTopPt + clampedLocalFrac * boxHeightPt).toFixed(2)),
        totalLines: null
      };
    }
  }
  return {
    localRatio: clampedLocalFrac,
    overallRatio: Number(clampedLocalFrac.toFixed(4)),
    snappedToEmpty: false,
    snappedToLines: false,
    snappedYPt: Number((boxTopPt + clampedLocalFrac * boxHeightPt).toFixed(2)),
    totalLines: null
  };
}

function computeVisualSplitRatio(boxEl, clientY) {
  return resolveVisualCutTarget(boxEl, clientY).overallRatio;
}

function updateCutGuideOnMove(e) {
  const box = findTextBoxForCutEvent(e);
  if (!box) {
    removeCutGuideLine();
    return null;
  }
  const { localRatio, overallRatio, snappedToEmpty } = resolveVisualCutTarget(box, e.clientY);

  let guide = box.querySelector?.(".cut-guide-line") || null;
  if (!guide) {
    removeCutGuideLine();
    guide = document.createElement("div");
    guide.className = "cut-guide-line";
    box.appendChild(guide);
  }
  guide.style.top = `${(localRatio * 100).toFixed(2)}%`;
  guide.dataset.label = snappedToEmpty
    ? `✂️ Potong • Akhir Baris (${Math.round(overallRatio * 100)}%)`
    : `✂️ Potong (${Math.round(overallRatio * 100)}%)`;
  return { box, localRatio, overallRatio, snappedToEmpty, guide };
}

function nextSplitBlockIdLocal(anchorId, blocks) {
  const existing = new Set((blocks || []).map(b => b?.id).filter(Boolean));
  const m = String(anchorId || "").match(/^([a-z]+-\d+)/);
  const base = m ? m[1] : String(anchorId || "blk");
  for (let code = 97; code <= 122; code++) {
    const cand = base + String.fromCharCode(code);
    if (!existing.has(cand)) return cand;
  }
  let idx = 1;
  while (existing.has(`${base}-${idx}`)) idx++;
  return `${base}-${idx}`;
}

function splitTextLocalByRatio(fullText, ratio) {
  const txt = String(fullText || "").trim();
  if (txt.length < 2) return [txt, ""];
  const clamped = Math.max(0.02, Math.min(0.98, Number(ratio) || 0.5));
  const target = Math.max(1, Math.min(txt.length - 1, Math.round(txt.length * clamped)));
  const before = txt.lastIndexOf(" ", target);
  const after = txt.indexOf(" ", target);
  let cutAt = -1;
  if (before > 0 && after > 0) {
    cutAt = (target - before <= after - target) ? before : after;
  } else if (before > 0) {
    cutAt = before;
  } else if (after > 0) {
    cutAt = after;
  }
  if (cutAt > 0 && cutAt < txt.length - 1) {
    const left = txt.slice(0, cutAt).trim();
    const right = txt.slice(cutAt).trim();
    if (left && right) return [left, right];
  }
  return [txt.slice(0, target).trim() || txt.slice(0, 1), txt.slice(target).trim() || txt.slice(1)];
}

function applyLocalFrozenSplit(bid, ratio, splitEntry = {}) {
  const S = window.EditorState;
  const origIdx = (S.blocks || []).findIndex(b => b.id === bid);
  if (origIdx < 0) return null;
  const rawBlk = S.blocks[origIdx];
  const effBlk = getEffectiveBlock(bid) || rawBlk;

  let newId = splitEntry.new_id;
  if (!newId || S.blocks.some(b => b.id === newId)) {
    newId = nextSplitBlockIdLocal(bid, S.blocks);
    splitEntry.new_id = newId;
  }

  const curFx = Number(splitEntry.freeze_x ?? effBlk?.style?.freeze_x ?? rawBlk?.style?.freeze_x ?? 0);
  const curFy = Number(splitEntry.freeze_y ?? effBlk?.style?.freeze_y ?? rawBlk?.style?.freeze_y ?? 0);
  const serverSt = rawBlk.style || {};
  const newRawStyle = Object.assign({}, serverSt, {
    spacing_above: 0,
    spacing_below: 0,
    break_before: "none",
    keep_with_next: false,
    no_indent: true,
    frozen: true,
    unlocked_in_freeze: false
  });

  const [leftText, rightText] = splitTextLocalByRatio(effBlk?.text || rawBlk.text || "", ratio);
  if (!S._localSplitTexts) S._localSplitTexts = {};
  if (!S._localSplitStyles) S._localSplitStyles = {};
  if (!S._localSplitNewIds) S._localSplitNewIds = {};
  S._localSplitTexts[bid] = leftText;
  S._localSplitTexts[newId] = rightText;
  S._localSplitStyles[bid] = Object.assign({}, S._localSplitStyles[bid] || {}, {
    spacing_below: 0,
    frozen: true,
    unlocked_in_freeze: false,
    freeze_x: curFx,
    freeze_y: curFy
  });
  S._localSplitStyles[newId] = Object.assign({}, serverSt, {
    spacing_above: 0,
    spacing_below: 0,
    break_before: "none",
    keep_with_next: false,
    no_indent: true,
    frozen: true,
    unlocked_in_freeze: false,
    freeze_x: curFx,
    freeze_y: curFy
  });
  S._localSplitNewIds[newId] = bid;
  if (S._freezeUnlockedIds) {
    delete S._freezeUnlockedIds[bid];
    delete S._freezeUnlockedIds[newId];
  }

  const newBlk = {
    id: newId,
    jenis: rawBlk.jenis || "paragraph",
    nomor: rawBlk.nomor ?? null,
    text: rightText,
    style: newRawStyle
  };
  S.blocks.splice(origIdx + 1, 0, newBlk);

  // Pecah layoutSegments secara presisi tanpa reflow (total tinggi = origH)
  const sortSegs = (arr) => arr.slice().sort((a, b) =>
    ((Number(a.page) || 1) - (Number(b.page) || 1)) ||
    ((Number(a.column) || 1) - (Number(b.column) || 1)) ||
    ((Number(a.y) || 0) - (Number(b.y) || 0)) ||
    ((Number(a.segment) || 0) - (Number(b.segment) || 0))
  );
  const recon = typeof getReconstructedSegments === "function"
    ? sortSegs(getReconstructedSegments().filter(s => s.id === bid))
    : [];
  const rawSegs = sortSegs((S.layoutSegments || []).filter(s => s.id === bid));
  const srcSegs = recon.length > 0 ? recon : rawSegs;

  if (srcSegs.length > 0) {
    const leftSegs = [];
    const rightSegs = [];
    const mkSeg = (baseSeg, segId, segIdx, y, h) => Object.assign({}, baseSeg, {
      id: segId,
      segment: segIdx,
      y: Number(y.toFixed(2)),
      height: Number(h.toFixed(2)),
      frozen: true,
      freeze_x: curFx,
      freeze_y: curFy
    });

    if (srcSegs.length === 1) {
      const s = srcSegs[0];
      const origY = Number(s.y) || 0;
      const origH = Math.max(2, Number(s.height) || 11);
      let h1;
      if (Number.isFinite(splitEntry.cut_y) && splitEntry.cut_y > origY + 0.5 && splitEntry.cut_y < origY + origH - 0.5) {
        h1 = Number((splitEntry.cut_y - origY).toFixed(2));
      } else {
        h1 = Number(Math.max(1, Math.min(origH - 1, origH * ratio)).toFixed(2));
      }
      const h2 = Number(Math.max(0.5, origH - h1).toFixed(2));
      leftSegs.push(mkSeg(s, bid, 0, origY, h1));
      rightSegs.push(mkSeg(s, newId, 0, origY + h1, h2));
    } else {
      let cutIdx = -1;
      let cutOffset = null;
      if (splitEntry.cut_page != null && Number.isFinite(splitEntry.cut_y)) {
        cutIdx = srcSegs.findIndex(s =>
          Number(s.page) === Number(splitEntry.cut_page) &&
          Number(s.column) === Number(splitEntry.cut_column || s.column) &&
          splitEntry.cut_y >= (Number(s.y) || 0) - 2 &&
          splitEntry.cut_y <= (Number(s.y) || 0) + (Number(s.height) || 0) + 2
        );
        if (cutIdx < 0) {
          cutIdx = srcSegs.findIndex(s => Number(s.page) === Number(splitEntry.cut_page) && Number(s.column) === Number(splitEntry.cut_column || s.column));
        }
        if (cutIdx >= 0) {
          cutOffset = splitEntry.cut_y - (Number(srcSegs[cutIdx].y) || 0);
        }
      }
      if (cutIdx < 0) {
        const totalH = srcSegs.reduce((acc, s) => acc + Math.max(1, Number(s.height) || 1), 0);
        let targetH = totalH * Math.max(0.02, Math.min(0.98, Number(ratio) || 0.5));
        for (let i = 0; i < srcSegs.length; i++) {
          const sh = Math.max(1, Number(srcSegs[i].height) || 1);
          if (targetH <= sh || i === srcSegs.length - 1) {
            cutIdx = i;
            cutOffset = targetH;
            break;
          }
          targetH -= sh;
        }
      }

      srcSegs.forEach((s, i) => {
        const sy = Number(s.y) || 0;
        const sh = Math.max(1, Number(s.height) || 1);
        if (i < cutIdx) {
          leftSegs.push(mkSeg(s, bid, leftSegs.length, sy, sh));
        } else if (i > cutIdx) {
          rightSegs.push(mkSeg(s, newId, rightSegs.length, sy, sh));
        } else {
          const off = Number(cutOffset ?? (sh * ratio));
          if (off <= 0.5 && i > 0) {
            rightSegs.push(mkSeg(s, newId, rightSegs.length, sy, sh));
          } else if (off >= sh - 0.5 && i < srcSegs.length - 1) {
            leftSegs.push(mkSeg(s, bid, leftSegs.length, sy, sh));
          } else {
            const h1 = Number(Math.max(1, Math.min(sh - 1, off)).toFixed(2));
            const h2 = Number(Math.max(0.5, sh - h1).toFixed(2));
            leftSegs.push(mkSeg(s, bid, leftSegs.length, sy, h1));
            rightSegs.push(mkSeg(s, newId, rightSegs.length, sy + h1, h2));
          }
        }
      });
    }

    S.layoutSegments = (S.layoutSegments || []).filter(s => s.id !== bid).concat(leftSegs, rightSegs);
    S._segCache = null;
  }

  return newId;
}

function replayLocalSplitsFromDraft() {
  const S = window.EditorState;
  const splits = Array.isArray(S.draft?.splits) ? S.draft.splits : [];
  for (const sp of splits) {
    if (!sp || !sp.block_id || sp.colbreak) continue;
    if (!S.blocks.some(b => b.id === sp.block_id)) continue;
    if (sp.new_id && S.blocks.some(b => b.id === sp.new_id)) continue;
    applyLocalFrozenSplit(sp.block_id, sp.split_ratio, sp);
  }
  if (splits.some(sp => sp?.frozen) && !S._freezeExplicitlyOff && !S.freezeLayout) {
    setFreezeLayoutUi(true);
  }
}

async function executeVisualSplit(bid, splitRatio, useColbreak = false, cutMeta = null) {
  const S = window.EditorState;
  const blk = getEffectiveBlock(bid);
  if (!blk || ["meta", "figure", "table"].includes(blk.jenis)) {
    showToast("Pilih blok teks terlebih dahulu untuk dipecah.");
    return false;
  }
  if ((S.draft.deletes || []).includes(bid)) {
    showToast("Blok yang ditandai hapus tidak dapat dipecah.");
    return false;
  }
  if (S.freezeLayout && !useColbreak && cutMeta?.cutTarget?.totalLines === 1) {
    showToast("⚠️ Blok 1 baris tidak dapat dipotong vertikal dalam mode Freeze tanpa menggeser teks di bawahnya.");
    return false;
  }
  const area = document.getElementById("prop-teks");
  const propId = document.getElementById("prop-id")?.value;
  if (area && propId === bid && area.value !== (blk.text || "")) {
    recordEditDraft(bid, { text: area.value });
  }
  const rawVal = (area && propId === bid) ? area.value : (blk.text || "");
  const fullText = String(rawVal || "").trim();
  if (fullText.length < 2) {
    showToast("Teks blok terlalu pendek untuk dipecah.");
    return false;
  }

  const isFrozenSplit = Boolean(S.freezeLayout || blk.style?.frozen || blk.style?.unlocked_in_freeze);
  const curFx = Number(blk.style?.freeze_x || 0);
  const curFy = Number(blk.style?.freeze_y || 0);
  if (isFrozenSplit && S.draft.edits?.[bid]?.style) {
    S.draft.edits[bid].style.frozen = true;
    S.draft.edits[bid].style.unlocked_in_freeze = false;
  }

  const ratio = Number(Math.max(0.02, Math.min(0.98, Number(splitRatio) || 0.5)).toFixed(4));
  if (!Array.isArray(S.draft.splits)) S.draft.splits = [];

  const splitEntry = {
    block_id: bid,
    split_ratio: ratio,
    colbreak: Boolean(useColbreak),
    frozen: isFrozenSplit,
    freeze_x: curFx,
    freeze_y: curFy
  };
  if (cutMeta?.cutTarget && Number.isFinite(cutMeta.cutTarget.snappedYPt)) {
    splitEntry.cut_y = Number(cutMeta.cutTarget.snappedYPt.toFixed(2));
    splitEntry.cut_page = parseInt(cutMeta.boxEl?.dataset?.page, 10) || null;
    splitEntry.cut_column = parseInt(cutMeta.boxEl?.dataset?.column, 10) || null;
  }

  // Mode Freeze (tanpa colbreak): pemotongan instan sebagai Draft Lokal (tanpa auto-render Typst server)
  if (S.freezeLayout && !useColbreak) {
    splitEntry.frozen = true;
    const predictedNewId = nextSplitBlockIdLocal(bid, S.blocks);
    splitEntry.new_id = predictedNewId;
    S.draft.splits.push(splitEntry);

    const newId = applyLocalFrozenSplit(bid, ratio, splitEntry);
    persistLocalDraft();
    populateMoveTargetSelect();
    renderObjectNavigator();
    rebuildAllOverlays();
    if (newId && S.blocks.some(b => b.id === newId)) {
      selectBlockById(newId, null, false);
      showToast(`✂️ Draft Lokal: ${bid} dipotong menjadi ${bid} + ${newId} (klik Simpan Perubahan untuk render PDF)`);
    } else {
      showToast(`✂️ Draft Lokal: ${bid} dipotong (klik Simpan Perubahan untuk render PDF)`);
    }
    return true;
  }

  S.draft.splits.push(splitEntry);
  persistLocalDraft();

  const beforeIds = new Set((S.blocks || []).map(b => b.id));
  const ok = await saveWorkspaceToServer();
  if (ok) {
    const splitInfo = Array.isArray(S._lastSaveResult?.splits)
      ? S._lastSaveResult.splits.find(sp => sp?.source_id === bid)
      : null;
    let newId = splitInfo?.new_id || null;
    if (!newId) {
      const added = (S.blocks || []).find(b => !beforeIds.has(b.id) && b.id !== bid);
      if (added) newId = added.id;
    }
    if (newId && S.blocks.some(b => b.id === newId)) {
      selectBlockById(newId, null, true);
      showToast(`✂️ Blok ${bid} dipotong (${Math.round(ratio * 100)}%) menjadi ${bid} + ${newId}${useColbreak ? " (#colbreak)" : ""}`);
    } else {
      showToast(`✂️ Blok ${bid} berhasil dipotong (${Math.round(ratio * 100)}%)${useColbreak ? " (#colbreak)" : ""}`);
    }
  }
  return ok;
}

async function handleVisualCutClick(e, boxEl) {
  const S = window.EditorState;
  const bid = boxEl?.dataset?.id;
  const kind = boxEl?.dataset?.kind;
  if (!bid || ["meta", "figure", "table"].includes(kind)) {
    showToast("⚠️ Hanya blok teks/paragraf yang dapat dipotong dengan gunting.");
    return false;
  }
  if ((S.draft.deletes || []).includes(bid)) {
    showToast("Blok yang ditandai hapus tidak dapat dipecah.");
    return false;
  }
  const blk = getEffectiveBlock(bid);
  const area = document.getElementById("prop-teks");
  const propId = document.getElementById("prop-id")?.value;
  const rawVal = (area && propId === bid) ? area.value : (blk?.text || "");
  if (String(rawVal || "").trim().length < 2) {
    showToast("Teks blok terlalu pendek untuk dipecah.");
    return false;
  }

  const cutTarget = resolveVisualCutTarget(boxEl, e.clientY);
  setCutMode(false);
  if (S.freezeLayout && cutTarget?.totalLines === 1) {
    showToast("⚠️ Blok 1 baris tidak dapat dipotong vertikal dalam mode Freeze tanpa menggeser teks di bawahnya.");
    return false;
  }
  return await executeVisualSplit(bid, cutTarget.overallRatio, false, { boxEl, cutTarget });
}

function resetLocalDraft() {
  const S = window.EditorState;
  if (!S.articleId || draftChangeCount() === 0) return;
  if (!window.confirm("Batalkan semua perubahan di Draft Lokal yang belum disimpan ke server?")) return;
  cancelAutoSave();
  S.draft = emptyDraft();
  S._freezeExplicitlyOff = false;
  S._freezeUnlockedIds = {};
  S._localSplitTexts = {};
  S._localSplitStyles = {};
  S._localSplitNewIds = {};
  persistLocalDraft();
  loadArticle(S.articleId);
}

async function serverUndoRedo(aksi) {
  const S = window.EditorState;
  if (!S.articleId) return;
  cancelAutoSave();
  setServerLoading(true, `⏳ Menjalankan ${aksi.toUpperCase()} di Server...`);
  try {
    const res = await apiFetch(aksi, {}, { artikel: S.articleId });
    S.draft = emptyDraft();
    persistLocalDraft();
    await applyWorkspaceState(res, true);
    showToast(aksi === "undo" ? "↶ Perubahan dibatalkan" : "↷ Perubahan diulangi");
  } catch (err) {
    showToast(`Gagal ${aksi}: ` + err.message);
  } finally {
    setServerLoading(false);
  }
}

async function downloadFinalPdf() {
  const S = window.EditorState;
  if (!S.articleId) { showToast("Pilih artikel terlebih dahulu"); return; }
  if (draftChangeCount() > 0 || _activeSavePromise) {
    showToast("💾 Menyimpan draft lokal sebelum mengunduh PDF...", 2000);
    const ok = await saveWorkspaceToServer();
    if (!ok) {
      showToast("Gagal menyimpan draft sebelum unduh PDF.", 3500);
      return;
    }
  }
  window.open(apiUrl("pdf", { artikel: S.articleId, v: Date.now() }), "_blank");
}

// ==================== 7. MODAL METADATA NASKAH ====================
function openMetadataModal(focusId = null) {
  const S = window.EditorState;
  if (!S.articleId) { showToast("Pilih artikel terlebih dahulu"); return; }
  META_IDS.forEach(([, bid, domId]) => {
    const blk = getEffectiveBlock(bid);
    const el = document.getElementById(domId);
    if (el) el.value = blk?.text || "";
  });
  const modal = document.getElementById("modal-metadata");
  if (modal) modal.hidden = false;
  if (focusId) {
    const match = META_IDS.find(([, bid]) => bid === focusId);
    if (match) document.getElementById(match[2])?.focus();
  }
}

function saveMetadataModalToDraft(e) {
  e.preventDefault();
  let changed = 0;
  META_IDS.forEach(([, bid, domId]) => {
    const el = document.getElementById(domId);
    const base = window.EditorState.blocks.find(b => b.id === bid);
    if (!el || !base) return;
    const val = el.value;
    if (val !== (getEffectiveBlock(bid)?.text || "")) {
      recordEditDraft(bid, { text: val });
      changed++;
    }
  });
  document.getElementById("modal-metadata").hidden = true;
  if (changed > 0) {
    showToast(`📝 ${changed} field metadata diperbarui — merender otomatis...`);
    scheduleAutoSave();
  }
}

// ==================== 8. FITUR CROP GAMBAR INTERAKTIF ====================
function captureBlockCanvasSnapshot(blockId) {
  const S = window.EditorState;
  const allSegs = getReconstructedSegments().filter(s => s.id === blockId);
  if (!allSegs.length) return "";
  const seg = allSegs.find(s => s.page === (S.activePage || 1)) || allSegs[0];
  if (!seg) return "";

  const pageCanvas = document.querySelector(`.pdf-page-sheet[data-page="${seg.page}"] .pdf-page-canvas`);
  if (!pageCanvas || !pageCanvas.width || !pageCanvas.height) return "";

  const scaleX = pageCanvas.width / 595.2756;
  const scaleY = pageCanvas.height / 841.8898;

  const padPt = 4;
  const xPt = Math.max(0, Number(seg.x || 0) - padPt);
  const yPt = Math.max(0, Number(seg.y || 0) - padPt);
  const wPt = Number(seg.width || 0) + padPt * 2;
  const hPt = Number(seg.height || 0) + padPt * 2;

  const sx = Math.floor(xPt * scaleX);
  const sy = Math.floor(yPt * scaleY);
  const sw = Math.min(pageCanvas.width - sx, Math.ceil(wPt * scaleX));
  const sh = Math.min(pageCanvas.height - sy, Math.ceil(hPt * scaleY));

  if (sw <= 0 || sh <= 0) return "";

  const offscreen = document.createElement("canvas");
  offscreen.width = sw;
  offscreen.height = sh;
  const ctx = offscreen.getContext("2d");
  if (!ctx) return "";

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, sw, sh);
  ctx.drawImage(pageCanvas, sx, sy, sw, sh, 0, 0, sw, sh);

  return offscreen.toDataURL("image/png");
}

function openCropModal() {
  const S = window.EditorState;
  const blk = getEffectiveBlock(S.selectedId);
  if (!blk || (blk.jenis !== "figure" && blk.jenis !== "table")) {
    showToast("Pilih objek Gambar atau Tabel terlebih dahulu");
    return;
  }
  const existing = S.draft.crops[blk.id] || blk.style?.crop || { left: 0, top: 0, right: 0, bottom: 0 };
  S.cropDrag = null;
  S.cropTarget = {
    blockId: blk.id,
    nomor: blk.nomor,
    jenis: blk.jenis,
    left: Number(existing.left) || 0,
    top: Number(existing.top) || 0,
    right: Number(existing.right) || 0,
    bottom: Number(existing.bottom) || 0
  };

  const img = document.getElementById("crop-img");
  const modal = document.getElementById("modal-crop");
  const defaultLabel = (blk.jenis === "table" ? "Table" : "Figure") + (blk.nomor ? " " + blk.nomor : "");
  document.getElementById("judul-modal-crop").textContent = `✂️ Crop ${blk.jenis === "table" ? "Tabel" : "Gambar"} ${blk.id} (${blk.judul || defaultLabel})`;
  modal.hidden = false;

  img.onload = () => requestAnimationFrame(() => updateCropRectDom());

  if (blk.jenis === "figure" && blk.nomor) {
    img.onerror = () => {
      img.onerror = null;
      const snap = captureBlockCanvasSnapshot(blk.id);
      if (snap) {
        img.src = snap;
      } else {
        showToast("Gagal memuat pratinjau gambar untuk dicrop");
      }
    };
    img.src = apiUrl("media_gambar", { artikel: S.articleId, nomor: blk.nomor, asli: 1, t: Date.now() });
  } else {
    img.onerror = null;
    const snap = captureBlockCanvasSnapshot(blk.id);
    if (snap) {
      img.src = snap;
    } else {
      showToast("Gagal mengambil snapshot objek untuk dicrop");
    }
  }
  requestAnimationFrame(() => updateCropRectDom());
}

function updateCropRectDom() {
  const ct = window.EditorState.cropTarget;
  const img = document.getElementById("crop-img");
  const rectEl = document.getElementById("crop-rect");
  const infoEl = document.getElementById("crop-coords-info");
  if (!ct || !img || !rectEl) return;

  const W = img.clientWidth || 1;
  const H = img.clientHeight || 1;
  const x = ct.left * W;
  const y = ct.top * H;
  const w = Math.max(20, (1 - ct.left - ct.right) * W);
  const h = Math.max(20, (1 - ct.top - ct.bottom) * H);

  rectEl.style.left = `${x}px`;
  rectEl.style.top = `${y}px`;
  rectEl.style.width = `${w}px`;
  rectEl.style.height = `${h}px`;
  if (infoEl) {
    infoEl.textContent = `Potong Tepi — Kiri: ${Math.round(ct.left * 100)}% • Atas: ${Math.round(ct.top * 100)}% • Kanan: ${Math.round(ct.right * 100)}% • Bawah: ${Math.round(ct.bottom * 100)}%`;
  }
}

function onCropPointerMove(e) {
  const cd = window.EditorState.cropDrag;
  const ct = window.EditorState.cropTarget;
  const img = document.getElementById("crop-img");
  if (!cd || !ct || !img) return;
  const W = img.clientWidth || 1;
  const H = img.clientHeight || 1;
  const dx = (e.clientX - cd.startX) / W;
  const dy = (e.clientY - cd.startY) / H;

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  if (cd.dir === "move") {
    const wFrac = 1 - cd.orig.left - cd.orig.right;
    const hFrac = 1 - cd.orig.top - cd.orig.bottom;
    ct.left = clamp(cd.orig.left + dx, 0, 1 - wFrac);
    ct.right = clamp(1 - ct.left - wFrac, 0, 0.9);
    ct.top = clamp(cd.orig.top + dy, 0, 1 - hFrac);
    ct.bottom = clamp(1 - ct.top - hFrac, 0, 0.9);
  } else {
    if (cd.dir.includes("w")) ct.left = clamp(cd.orig.left + dx, 0, 0.85 - ct.right);
    if (cd.dir.includes("e")) ct.right = clamp(cd.orig.right - dx, 0, 0.85 - ct.left);
    if (cd.dir.includes("n")) ct.top = clamp(cd.orig.top + dy, 0, 0.85 - ct.bottom);
    if (cd.dir.includes("s")) ct.bottom = clamp(cd.orig.bottom - dy, 0, 0.85 - ct.top);
  }
  updateCropRectDom();
}

// ==================== 9. FORM BUILD NASKAH BARU + LIVE LOG POLLING ====================
async function submitBuildForm(e) {
  e.preventDefault();
  const form = e.target;
  const btn = document.getElementById("btn-submit-bangun");
  const logEl = document.getElementById("log-bangun");
  if (btn) btn.disabled = true;
  if (logEl) { logEl.hidden = false; logEl.textContent = "⏳ Mengunggah .docx dan memulai build.py...\n"; }

  try {
    const res = await apiFetch("bangun", {}, new FormData(form));
    const nama = res.nama;
    showToast(`Build "${nama}" dimulai di server...`);
    if (_buildPollTimer) clearInterval(_buildPollTimer);

    _buildPollTimer = setInterval(async () => {
      try {
        const st = await apiFetch("log", { nama });
        if (logEl && st.log) {
          logEl.textContent = st.log;
          logEl.scrollTop = logEl.scrollHeight;
        }
        if (st.selesai) {
          clearInterval(_buildPollTimer);
          _buildPollTimer = null;
          if (btn) btn.disabled = false;
          if (st.artikel_ada) {
            document.getElementById("modal-baru").hidden = true;
            showToast(`✅ Naskah "${nama}" selesai dibangun!`);
            await loadArticleList(nama);
            await loadArticle(nama);
          } else {
            showToast(`⚠️ Build selesai tetapi hasil belum tersedia. Periksa log.`, 4200);
          }
        }
      } catch (pollErr) {
        clearInterval(_buildPollTimer);
        _buildPollTimer = null;
        if (btn) btn.disabled = false;
        showToast("Gagal membaca log build: " + pollErr.message);
      }
    }, 1600);
  } catch (err) {
    if (btn) btn.disabled = false;
    if (logEl) logEl.textContent += "\n❌ Galat: " + err.message;
    showToast("Gagal memulai build: " + err.message, 4000);
  }
}

// ==================== 10. EVENT BINDINGS ====================
let _bound = false;
function bindToolbarAndInspector() {
  if (_bound) return;
  _bound = true;
  const on = (id, evt, fn) => document.getElementById(id)?.addEventListener(evt, fn);

  // Sidebar Tabs (Artikel vs Select Object)
  on("tab-btn-artikel", "click", () => {
    document.getElementById("tab-btn-artikel")?.classList.add("aktif");
    document.getElementById("tab-btn-objek")?.classList.remove("aktif");
    document.getElementById("panel-tab-artikel").hidden = false;
    document.getElementById("panel-tab-objek").hidden = true;
  });
  on("tab-btn-objek", "click", () => {
    document.getElementById("tab-btn-objek")?.classList.add("aktif");
    document.getElementById("tab-btn-artikel")?.classList.remove("aktif");
    document.getElementById("panel-tab-objek").hidden = false;
    document.getElementById("panel-tab-artikel").hidden = true;
    renderObjectNavigator();
  });
  on("cari-objek", "input", () => renderObjectNavigator());
  on("filter-jenis-objek", "change", () => renderObjectNavigator());

  // Toolbar
  on("btn-undo", "click", () => serverUndoRedo("undo"));
  on("btn-redo", "click", () => serverUndoRedo("redo"));
  on("btn-toggle-frames", "click", () => {
    const k = document.getElementById("kanvas-pdf"), b = document.getElementById("btn-toggle-frames");
    if (k) k.classList.toggle("show-frames");
    if (b && k) b.classList.toggle("btn-aktif", k.classList.contains("show-frames"));
  });
  on("btn-preview-mode", "click", () => togglePreviewMode());
  on("btn-toggle-grid", "click", () => {
    const S = window.EditorState;
    S.showGrid = !S.showGrid;
    const k = document.getElementById("kanvas-pdf");
    const b = document.getElementById("btn-toggle-grid");
    if (k) k.classList.toggle("show-grid", S.showGrid);
    if (b) b.classList.toggle("btn-aktif", S.showGrid);
    showToast(S.showGrid ? "📏 Grid 11pt & Snap-to-Grid aktif" : "📏 Grid 11pt dimatikan (geser bebas)");
  });
  on("btn-cut-mode", "click", () => toggleCutMode());
  on("btn-freeze-layout", "click", () => {
    const S = window.EditorState;
    const nextState = !S.freezeLayout;
    S._freezeExplicitlyOff = !nextState;
    S._freezeUnlockedIds = {};
    if (nextState) {
      cancelAutoSave();
    }
    setFreezeLayoutUi(nextState);
    rebuildAllOverlays();
    refreshDraftUi();
    if (S.selectedId) setSelection(S.selectedIds, S.selectedId, S.activePage, false);
    showToast(nextState
      ? "🔒 Freeze Layout AKTIF: seluruh halaman dikunci (zero-render). Klik blok 1x untuk buka kunci (🔓) lalu geser/resize/edit dengan auto-render."
      : "🔓 Freeze Layout NONAKTIF: Tata letak normal & auto-save aktif.");
  });
  on("zoom", "input", e => {
    const z = parseInt(e.target.value, 10) || 100;
    window.EditorState.zoom = z;
    document.getElementById("zoom-val").textContent = `${z}%`;
    document.getElementById("kanvas-pdf").style.transform = `scale(${z / 100})`;
  });
  on("btn-simpan-server", "click", () => saveWorkspaceToServer());
  on("btn-reset-draft", "click", () => resetLocalDraft());
  on("btn-cetak-pdf", "click", () => downloadFinalPdf());
  on("btn-toggle-prop", "click", () => {
    const p = document.getElementById("panel-properti");
    if (p) p.hidden = !p.hidden;
  });
  on("btn-tutup-prop", "click", () => { document.getElementById("panel-properti").hidden = true; });

  // Inspector -> Local Draft + Debounced Auto-Render
  on("prop-teks", "input", () => {
    const bid = window.EditorState.selectedId;
    if (!bid) return;
    if (!guardFreezeInspectorEdit(bid)) return;
    const val = document.getElementById("prop-teks")?.value ?? "";
    if (val !== (getEffectiveBlock(bid)?.text ?? "")) {
      if (window.EditorState.freezeLayout) {
        recordEditDraft(bid, { text: val, style: withFreezeSlotPatch(bid, {}) });
      } else {
        recordEditDraft(bid, { text: val });
      }
      scheduleAutoSave(1800);
    }
  });
  on("btn-terapkan-teks", "click", () => {
    const bid = window.EditorState.selectedId;
    if (!bid) return;
    if (!guardFreezeInspectorEdit(bid)) return;
    const val = document.getElementById("prop-teks")?.value ?? "";
    if (window.EditorState.freezeLayout) {
      recordEditDraft(bid, { text: val, style: withFreezeSlotPatch(bid, {}) });
    } else {
      recordEditDraft(bid, { text: val });
    }
    showToast(`Teks ${bid} diperbarui — merender otomatis...`);
    scheduleAutoSave();
  });
  on("btn-hapus-blok", "click", () => {
    const S = window.EditorState;
    const rawIds = Array.isArray(S.selectedIds) && S.selectedIds.length > 1
      ? S.selectedIds
      : (S.selectedId ? [S.selectedId] : []);
    const nonMetaIds = rawIds.filter(id => {
      const b = getEffectiveBlock(id);
      return b && b.jenis !== "meta";
    });
    if (nonMetaIds.length === 0) return;

    if (nonMetaIds.length === 1) {
      const bid = nonMetaIds[0];
      const idx = S.draft.deletes.indexOf(bid);
      if (idx >= 0) {
        S.draft.deletes.splice(idx, 1);
        showToast(`Penghapusan ${bid} dibatalkan`);
      } else {
        S.draft.deletes.push(bid);
        showToast(`Blok ${bid} dihapus — merender otomatis...`);
      }
    } else {
      let added = 0;
      nonMetaIds.forEach(bid => {
        if (!S.draft.deletes.includes(bid)) {
          S.draft.deletes.push(bid);
          added++;
        }
      });
      if (added > 0) showToast(`🗑️ ${added} blok dihapus — merender otomatis...`);
    }
    persistLocalDraft();
    markModifiedBoxesOnDom();
    scheduleAutoSave();
  });
  on("prop-skala", "input", e => {
    document.getElementById("prop-skala-val").textContent = `${e.target.value}%`;
  });
  on("prop-skala", "change", e => {
    const bid = window.EditorState.selectedId;
    if (!bid) return;
    if (!guardFreezeInspectorEdit(bid)) return;
    const pct = parseFloat(e.target.value) || 100;
    const blk = getEffectiveBlock(bid);
    const stylePatch = { width_pct: pct };
    if (blk?.jenis === "table") {
      stylePatch.font_size = Number(Math.max(7.5, Math.min(13.5, 11 * (pct / 100))).toFixed(2));
      stylePatch.cell_pad = Number(Math.max(1.5, Math.min(7.0, 4 * (pct / 100))).toFixed(2));
    }
    recordEditDraft(bid, { style: withFreezeSlotPatch(bid, stylePatch) });
    scheduleAutoSave();
  });
  on("prop-keputusan", "change", e => {
    const bid = window.EditorState.selectedId;
    if (bid) {
      recordEditDraft(bid, { style: { placement: e.target.value } });
      scheduleAutoSave();
    }
  });
  on("prop-penuh", "change", e => {
    const bid = window.EditorState.selectedId;
    if (bid) {
      recordEditDraft(bid, { style: { span: e.target.checked ? "page" : "column" } });
      scheduleAutoSave();
    }
  });
  on("btn-terapkan-pindah", "click", () => {
    const S = window.EditorState;
    const rawIds = Array.isArray(S.selectedIds) && S.selectedIds.length
      ? S.selectedIds
      : (S.selectedId ? [S.selectedId] : []);
    const targetId = document.getElementById("prop-target-id")?.value;
    const pos = document.getElementById("prop-move-pos")?.value || "before";
    const orderedIds = getOrderedMovableIds(rawIds).filter(id => id !== targetId);
    if (!orderedIds.length || !targetId) return;

    S.draft.moves.push({ block_ids: orderedIds, target_id: targetId, position: pos });
    applyLocalMoveToBlocks(orderedIds, targetId, pos);
    persistLocalDraft();
    rebuildAllOverlays();
    renderObjectNavigator();
    setSelection(orderedIds, orderedIds[0], null, false);
    showToast(
      orderedIds.length > 1
        ? `📦 ${orderedIds.length} objek dipindah ${pos === "before" ? "sebelum" : "sesudah"} ${targetId}`
        : `Urutan ${orderedIds[0]} dipindah ${pos === "before" ? "sebelum" : "sesudah"} ${targetId}`
    );
    scheduleAutoSave();
  });
  on("prop-break-before", "change", e => {
    const bid = window.EditorState.selectedId;
    if (bid) {
      recordEditDraft(bid, { style: { break_before: e.target.value } });
      rebuildAllOverlays();
      scheduleAutoSave();
    }
  });
  on("prop-spasi-atas", "change", e => {
    const bid = window.EditorState.selectedId;
    if (bid) {
      recordEditDraft(bid, { style: { spacing_above: parseFloat(e.target.value) || 0 } });
      scheduleAutoSave();
    }
  });
  on("prop-kepala-turun", "input", e => {
    const v = parseInt(e.target.value, 10) || 0;
    document.getElementById("prop-kepala-val").textContent = formatMarginOffsetText(v);
  });
  on("prop-kepala-turun", "change", e => {
    const S = window.EditorState;
    const hal = S.activePage || 1;
    const v = Math.max(-2, Math.min(2, parseInt(e.target.value, 10) || 0));
    S.draft.header_naik[hal] = v;
    persistLocalDraft();
    rebuildAllOverlays();
    scheduleAutoSave();
  });

  on("prop-kaki-naik", "input", e => {
    const v = parseInt(e.target.value, 10) || 0;
    document.getElementById("prop-kaki-val").textContent = formatMarginOffsetText(v);
  });
  on("prop-kaki-naik", "change", e => {
    const S = window.EditorState;
    const hal = S.activePage || 1;
    const v = Math.max(-2, Math.min(2, parseInt(e.target.value, 10) || 0));
    S.draft.kaki_naik[hal] = v;
    persistLocalDraft();
    rebuildAllOverlays();
    scheduleAutoSave();
  });

  // Metadata Modal
  on("btn-metadata", "click", () => openMetadataModal());
  on("btn-tutup-metadata", "click", () => { document.getElementById("modal-metadata").hidden = true; });
  on("btn-batal-metadata", "click", () => { document.getElementById("modal-metadata").hidden = true; });
  on("form-metadata", "submit", saveMetadataModalToDraft);

  // Crop Modal
  on("btn-buka-crop", "click", () => openCropModal());
  on("btn-tutup-crop", "click", () => { document.getElementById("modal-crop").hidden = true; });
  on("btn-reset-crop", "click", () => {
    const ct = window.EditorState.cropTarget;
    if (!ct) return;
    ct.left = 0; ct.top = 0; ct.right = 0; ct.bottom = 0;
    updateCropRectDom();
  });
  on("btn-simpan-crop", "click", () => {
    const S = window.EditorState;
    const ct = S.cropTarget;
    if (!ct) return;
    const isReset = ct.left < 0.005 && ct.top < 0.005 && ct.right < 0.005 && ct.bottom < 0.005;
    S.draft.crops[ct.blockId] = {
      block_id: ct.blockId,
      nomor: ct.nomor,
      jenis: ct.jenis,
      left: Number(ct.left.toFixed(4)),
      top: Number(ct.top.toFixed(4)),
      right: Number(ct.right.toFixed(4)),
      bottom: Number(ct.bottom.toFixed(4)),
      reset: isReset
    };
    persistLocalDraft();
    rebuildAllOverlays();
    document.getElementById("modal-crop").hidden = true;
    showToast(`✂️ Area crop ${ct.blockId} diterapkan — merender otomatis...`);
    scheduleAutoSave();
  });
  document.getElementById("crop-rect")?.addEventListener("pointerdown", e => {
    const ct = window.EditorState.cropTarget;
    if (!ct) return;
    cancelAutoSave();
    e.stopPropagation();
    const dir = e.target.dataset?.cdir || "move";
    window.EditorState.cropDrag = {
      dir,
      startX: e.clientX,
      startY: e.clientY,
      orig: { left: ct.left, top: ct.top, right: ct.right, bottom: ct.bottom }
    };
  });

  // Login / Logout / Build Modal
  on("form-masuk", "submit", async e => {
    e.preventDefault();
    try {
      const res = await apiFetch("masuk", {}, new FormData(e.target));
      if (res?.ok) {
        document.body.className = "masuk";
        document.getElementById("layar-masuk")?.setAttribute("hidden", "");
        document.getElementById("aplikasi")?.removeAttribute("hidden");
        await loadArticleList();
      }
    } catch (err) {
      const p = document.getElementById("pesan-masuk");
      if (p) p.textContent = err.message || "Kata sandi salah";
    }
  });
  on("btn-keluar", "click", async () => {
    try { await apiFetch("keluar"); } catch (_) {}
    document.body.className = "belum";
    document.getElementById("layar-masuk")?.removeAttribute("hidden");
    document.getElementById("aplikasi")?.setAttribute("hidden", "");
  });
  on("btn-baru", "click", () => {
    document.getElementById("modal-baru").hidden = false;
  });
  on("btn-batal-baru", "click", () => {
    if (_buildPollTimer) { clearInterval(_buildPollTimer); _buildPollTimer = null; }
    document.getElementById("modal-baru").hidden = true;
  });
  on("form-baru", "submit", submitBuildForm);

  const vpEl = document.getElementById("viewport-utama") || document.getElementById("kanvas-pdf");
  vpEl?.addEventListener("pointerdown", onCanvasPointerDown);
  document.getElementById("kanvas-pdf")?.addEventListener("pointerleave", () => {
    if (window.EditorState.isCutMode) removeCutGuideLine();
  });
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("keydown", e => {
    if (e.key === "Escape" && window.EditorState.previewMode) {
      e.preventDefault();
      setPreviewMode(false);
      return;
    }
    if (e.key === "Escape" && window.EditorState.isCutMode) {
      e.preventDefault();
      setCutMode(false);
      showToast("✂️ Mode Potong dibatalkan.");
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveWorkspaceToServer();
    } else if ((e.ctrlKey || e.metaKey) && !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) {
      if (e.key.toLowerCase() === "z") { e.preventDefault(); serverUndoRedo(e.shiftKey ? "redo" : "undo"); }
      else if (e.key.toLowerCase() === "y") { e.preventDefault(); serverUndoRedo("redo"); }
    }
  });
}

const _startApp = () => {
  bindToolbarAndInspector();
  if (document.body?.classList.contains("masuk")) loadArticleList();
};
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", _startApp);
else _startApp();
