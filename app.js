/* 意大利语跟读 — phone-only app (library, in-browser Whisper, player, export). */
const MODELS = {
  "onnx-community/whisper-tiny": { label: "whisper-tiny", downloadMB: 43 },
  "onnx-community/whisper-base": { label: "whisper-base", downloadMB: 77 },
};
const RATE = 16000;
const CJK_RE = /[\u4e00-\u9fff]/;
const SENT_END_RE = /([.!?…]+)(?:\s+|$)/;

const $ = (id) => document.getElementById(id);
const filePick = $("filePick");
const modelSel = $("modelSel");

let cancelled = false;
let worker = null;
let currentLesson = null;
let currentAudioUrl = null;
let playerCtl = null;

/* ---------------- views ---------------- */
function showView(name) {
  document.body.classList.remove("view-lib", "view-work", "view-player");
  document.body.classList.add("view-" + name);
  if (name !== "player") document.body.classList.remove("hide-zh");
}

function isSecure() {
  return window.isSecureContext || location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1";
}

/* ---------------- IndexedDB ---------------- */
const DB_NAME = "miraa-phone";
const DB_VER = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("lessons")) {
        db.createObjectStore("lessons", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("recordings")) {
        db.createObjectStore("recordings");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbOp(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const st = tx.objectStore(store);
    const req = fn(st);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const listLessons = () => idbOp("lessons", "readonly", (s) => s.getAll());
const getLesson = (id) => idbOp("lessons", "readonly", (s) => s.get(id));
const putLesson = (lesson) => idbOp("lessons", "readwrite", (s) => s.put(lesson));
const delLesson = (id) => idbOp("lessons", "readwrite", (s) => s.delete(id));
const putRec = (key, blob) => idbOp("recordings", "readwrite", (s) => s.put(blob, key));
const getRec = (key) => idbOp("recordings", "readonly", (s) => s.get(key));

/* ---------------- library ---------------- */
async function refreshLibrary() {
  const box = $("libList");
  let items = [];
  try { items = (await listLessons()) || []; } catch (e) { items = []; }
  items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  box.innerHTML = "";
  if (!items.length) {
    box.innerHTML = '<div class="empty">还没有保存的课。选择一个音视频文件开始。</div>';
    return;
  }
  for (const L of items) {
    const card = document.createElement("div");
    card.className = "card lesson-item";
    const left = document.createElement("div");
    left.innerHTML = "<h3></h3><p></p>";
    left.querySelector("h3").textContent = L.title || "未命名课程";
    const when = L.createdAt ? new Date(L.createdAt).toLocaleString("zh-CN", { hour12: false }) : "";
    left.querySelector("p").textContent = [fmtDur(L.duration), (L.sentences || []).length + " 句", when].filter(Boolean).join(" · ");
    const del = document.createElement("button");
    del.type = "button";
    del.className = "danger";
    del.textContent = "删除";
    del.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      if (!confirm("删除这堂课？")) return;
      await delLesson(L.id);
      refreshLibrary();
    });
    card.appendChild(left);
    card.appendChild(del);
    card.addEventListener("click", () => openLesson(L.id));
    box.appendChild(card);
  }
}

/* ---------------- work progress ---------------- */
function workLog(line) {
  const el = $("workLog");
  const t = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  el.textContent += `[${t}] ${line}\n`;
  el.scrollTop = el.scrollHeight;
  console.log("[miraa]", line);
}
function setWork(title, detail, pct) {
  if (title) $("workTitle").textContent = title;
  if (detail != null) $("workDetail").textContent = detail;
  if (typeof pct === "number" && Number.isFinite(pct)) {
    const p = Math.max(0, Math.min(100, Math.round(pct)));
    $("workBar").style.width = p + "%";
    $("workPct").textContent = p + "%";
  }
}

/* ---------------- audio decode / resample ---------------- */
function mixMono(buf) {
  const n = buf.length;
  const ch = buf.numberOfChannels;
  const mono = new Float32Array(n);
  for (let c = 0; c < ch; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += d[i] / ch;
  }
  return { data: mono, sampleRate: buf.sampleRate, duration: buf.duration };
}

function resampleLinear(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const destLen = Math.max(1, Math.round(input.length * toRate / fromRate));
  const out = new Float32Array(destLen);
  const ratio = input.length / destLen;
  for (let i = 0; i < destLen; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = x - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

async function decodeTo16kMono(file) {
  const raw = await file.arrayBuffer();
  const copy = raw.slice(0);
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx({ sampleRate: RATE });
  let buf;
  try {
    buf = await ctx.decodeAudioData(copy);
  } finally {
    try { await ctx.close(); } catch (e) {}
  }
  const mixed = mixMono(buf);
  const data = resampleLinear(mixed.data, mixed.sampleRate, RATE);
  return { pcm: data, duration: data.length / RATE, sourceRate: mixed.sampleRate };
}

function encodeWav(pcm, sampleRate = RATE) {
  const samples = pcm.length;
  const buf = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(buf);
  const w = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  w(0, "RIFF");
  v.setUint32(4, 36 + samples * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, samples * 2, true);
  let o = 44;
  for (let i = 0; i < samples; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

function encodeMp3(pcm, sampleRate = RATE, kbps = 64) {
  if (!window.lamejs) return null;
  try {
    const enc = new lamejs.Mp3Encoder(1, sampleRate, kbps);
    const samples = new Int16Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) {
      const s = Math.max(-1, Math.min(1, pcm[i]));
      samples[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    const parts = [];
    const block = 1152;
    for (let i = 0; i < samples.length; i += block) {
      const out = enc.encodeBuffer(samples.subarray(i, i + block));
      if (out && out.length) parts.push(new Uint8Array(out));
    }
    const end = enc.flush();
    if (end && end.length) parts.push(new Uint8Array(end));
    if (!parts.length) return null;
    return new Blob(parts, { type: "audio/mpeg" });
  } catch (e) {
    console.warn("lamejs encode failed", e);
    return null;
  }
}

async function playbackBlob(file, pcm) {
  const audioTypes = ["audio/mpeg", "audio/mp3", "audio/mp4", "audio/aac", "audio/wav", "audio/ogg", "audio/webm", "audio/flac", "audio/x-m4a"];
  const type = (file.type || "").toLowerCase();
  const name = (file.name || "").toLowerCase();
  const isAudio = type.startsWith("audio/") || audioTypes.includes(type) || /\.(mp3|m4a|aac|wav|ogg|opus|flac)$/.test(name);
  if (isAudio && file.size && file.size < 20 * 1048576) return file;
  return encodeMp3(pcm) || encodeWav(pcm);
}

/* ---------------- sentences ---------------- */
function splitSentencesInText(text) {
  text = String(text || "").replace(/\s+/g, " ").trim();
  if (!text) return [];
  const parts = [];
  let last = 0;
  const re = new RegExp(SENT_END_RE.source, "g");
  let m;
  while ((m = re.exec(text))) {
    const chunk = text.slice(last, m.index + m[1].length).trim();
    if (chunk) parts.push(chunk);
    last = m.index + m[0].length;
  }
  const tail = text.slice(last).trim();
  if (tail) parts.push(tail);
  return parts.length ? parts : [text];
}

function toSentenceSegments(segments) {
  const split = [];
  for (const seg of segments) {
    const parts = splitSentencesInText(seg.text);
    if (parts.length <= 1) {
      split.push({ ...seg, text: (seg.text || "").trim() });
      continue;
    }
    const total = parts.reduce((a, p) => a + Math.max(1, p.length), 0);
    const dur = Math.max(0, seg.end - seg.start);
    let t = seg.start;
    parts.forEach((p, i) => {
      const share = dur && total ? dur * (p.length / total) : 0;
      const end = i === parts.length - 1 ? seg.end : t + Math.max(0.35, share);
      split.push({ start: t, end, text: p });
      t = end;
    });
  }
  const merged = [];
  let buf = [];
  const flush = () => {
    if (!buf.length) return;
    merged.push({
      start: buf[0].start,
      end: buf[buf.length - 1].end,
      text: buf.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim(),
    });
    buf = [];
  };
  for (const seg of split) {
    if (!buf.length) {
      buf = [seg];
      if (SENT_END_RE.test(seg.text.trim()) && seg.text.split(/\s+/).length >= 2) flush();
      continue;
    }
    const span = seg.end - buf[0].start;
    const gap = seg.start - buf[buf.length - 1].end;
    if (gap > 1.2 || span > 18) {
      flush();
      buf = [seg];
    } else buf.push(seg);
    if (buf.length && SENT_END_RE.test(buf[buf.length - 1].text.trim())) flush();
  }
  flush();
  return merged.filter((s) => s.text && !/^[.!?…]+$/.test(s.text)).map((s) => ({
    start: s.start,
    end: s.end > s.start ? s.end : s.start + 0.6,
    text: s.text,
  }));
}

/* ---------------- translation ---------------- */
async function translateOne(text) {
  const url = "https://api.mymemory.translated.net/get?" + new URLSearchParams({ q: text, langpair: "it|zh-CN" });
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  const data = await resp.json();
  let zh = ((data.responseData || {}).translatedText || "").trim();
  if (zh.includes("MYMEMORY WARNING")) zh = "";
  return zh;
}

async function translateSentences(texts, onEach) {
  const out = [];
  let method = "MyMemory API it|zh-CN";
  let ok = 0;
  for (let i = 0; i < texts.length; i++) {
    if (cancelled) throw new Error("已取消");
    let zh = "";
    try { zh = await translateOne(texts[i]); } catch (e) { zh = ""; }
    if (!CJK_RE.test(zh)) zh = zh && !/^[A-Za-z0-9 .,!?'’“”:-]+$/.test(zh) ? zh : "";
    // Accept CJK; drop pure-Latin fallbacks (MyMemory sometimes returns English)
    if (CJK_RE.test(zh)) ok++;
    else zh = CJK_RE.test(zh) ? zh : (zh && CJK_RE.test(zh) ? zh : (CJK_RE.test(zh) ? zh : (zh && /[\u4e00-\u9fff]/.test(zh) ? zh : "")));
    // simplify: keep only if it has CJK
    if (!CJK_RE.test(zh)) zh = "";
    out.push(zh);
    if (onEach) onEach(i + 1, texts.length, zh);
    if (i < texts.length - 1) await sleep(120);
  }
  if (ok === 0) method = "none (translation failed)";
  else if (ok < texts.length) method = "MyMemory API it|zh-CN (partial)";
  return { zh: out, method, ok };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ---------------- worker ---------------- */
function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  return worker;
}

function waitWorker(onProgress) {
  const w = ensureWorker();
  return new Promise((resolve, reject) => {
    const handle = (ev) => {
      const msg = ev.data || {};
      if (msg.type === "progress" || msg.type === "log") {
        if (onProgress) onProgress(msg);
        return;
      }
      if (msg.type === "ready" || msg.type === "result") {
        w.removeEventListener("message", handle);
        resolve(msg);
      } else if (msg.type === "error") {
        w.removeEventListener("message", handle);
        reject(new Error(msg.message || "识别失败"));
      }
    };
    w.addEventListener("message", handle);
  });
}

async function loadModel(modelId, onProgress) {
  const w = ensureWorker();
  const p = waitWorker(onProgress);
  w.postMessage({ type: "load", modelId, preferGpu: true });
  return p;
}

async function runTranscribe(pcm, onProgress) {
  const w = ensureWorker();
  const p = waitWorker(onProgress);
  w.postMessage({ type: "transcribe", audio: pcm }, [pcm.buffer]);
  return p;
}

/* ---------------- pipeline ---------------- */
async function processFile(file) {
  cancelled = false;
  showView("work");
  $("workLog").textContent = "";
  setWork("正在读取文件…", file.name || "未命名", 2);
  workLog("文件：" + (file.name || "") + " · " + fmtBytes(file.size));

  let pcm, duration;
  try {
    setWork("正在提取音频…", "解码并重采样为 16 kHz 单声道", 8);
    const decoded = await decodeTo16kMono(file);
    pcm = decoded.pcm;
    duration = decoded.duration;
    workLog(`音频时长 ${fmtDur(duration)}，采样率已转为 16 kHz 单声道（原 ${Math.round(decoded.sourceRate)} Hz）`);
    if (duration > 12 * 60) {
      workLog("文件较长，手机上识别会比较慢。建议先截成几分钟再导入。");
    }
  } catch (e) {
    setWork("无法提取音频", (e && e.message) || String(e), 0);
    workLog("解码失败。请试试 MP3、M4A、WAV，或先把视频导出成音频。");
    workLog(String(e && e.message ? e.message : e));
    return;
  }
  if (cancelled) return;

  const modelId = modelSel.value;
  const meta = MODELS[modelId] || { label: modelId, downloadMB: "?" };
  setWork("正在加载语音识别模型…", `首次需要下载约 ${meta.downloadMB} MB（${meta.label}），之后可走缓存`, 12);
  let ready;
  try {
    ready = await loadModel(modelId, (msg) => {
      if (cancelled) return;
      if (msg.type === "log") { workLog(msg.message); return; }
      const fileName = (msg.file || "").split("/").pop();
      if (msg.phase === "download") {
        const pct = 12 + Math.round((msg.pct || 0) * 0.25);
        const detail = msg.total
          ? `正在下载 ${fileName || "模型"} ${fmtBytes(msg.loaded)} / ${fmtBytes(msg.total)}`
          : (msg.status === "done" ? `已就绪 ${fileName}` : `加载中… ${fileName || ""}`);
        setWork("正在加载语音识别模型…", detail, pct);
      }
    });
    workLog(`模型就绪：${ready.modelId} · 设备 ${ready.device} · 精度 ${ready.dtype}`);
  } catch (e) {
    setWork("模型加载失败", (e && e.message) || String(e), 0);
    workLog(String(e && e.message ? e.message : e));
    return;
  }
  if (cancelled) return;

  setWork("正在识别意大利语…", "请不要锁屏，识别在本地进行", 40);
  const t0 = performance.now();
  let result;
  try {
    // postMessage transfers the buffer, so keep a copy for encoding later
    const pcmCopy = pcm.slice(0);
    result = await runTranscribe(pcm, (msg) => {
      if (cancelled) return;
      if (msg.type === "log") { workLog(msg.message); return; }
      if (msg.phase === "transcribe") {
        const pct = 40 + Math.round((msg.pct || 0) * 0.35);
        const extra = msg.doneSec != null ? `已处理 ${fmtDur(msg.doneSec)} / ${fmtDur(msg.totalSec)}` : "识别中…";
        setWork("正在识别意大利语…", extra, pct);
      }
    });
    pcm = pcmCopy;
  } catch (e) {
    setWork("识别失败", (e && e.message) || String(e), 0);
    workLog(String(e && e.message ? e.message : e));
    return;
  }
  const transcribeMs = performance.now() - t0;
  const segs = result.segments || [];
  workLog(`识别完成：${segs.length} 段，用时 ${(transcribeMs / 1000).toFixed(1)} 秒（约 ${duration ? ((transcribeMs / 1000) / (duration / 60)).toFixed(1) : "?"} 秒/分钟音频）`);
  if (cancelled) return;

  const sentences = toSentenceSegments(segs);
  workLog(`合并为 ${sentences.length} 个句子`);
  if (!sentences.length) {
    setWork("没有识别出句子", "可以换一个更清晰的录音，或改用「较准」模型再试。", 0);
    return;
  }

  setWork("正在翻译成中文…", `0 / ${sentences.length}`, 78);
  let zh = [], method = "none";
  try {
    const tr = await translateSentences(sentences.map((s) => s.text), (i, n) => {
      setWork("正在翻译成中文…", `${i} / ${n}`, 78 + Math.round((i / n) * 18));
    });
    zh = tr.zh;
    method = tr.method;
    workLog(`翻译：${method}，成功 ${tr.ok}/${sentences.length}`);
  } catch (e) {
    workLog("翻译失败，将只保留意大利语：" + ((e && e.message) || e));
    zh = sentences.map(() => "");
    method = "none (translation failed)";
  }
  if (cancelled) return;

  setWork("正在保存课程…", "写入本机（可离线打开）", 97);
  const audioBlob = await playbackBlob(file, pcm);
  const id = "L" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const title = (file.name || "意大利语跟读").replace(/\.[^.]+$/, "");
  const lesson = {
    id,
    title,
    createdAt: Date.now(),
    duration: result.duration || duration,
    sourceName: file.name || "",
    model: ready.modelId,
    device: ready.device,
    dtype: ready.dtype,
    translationMethod: method,
    transcribeMs,
    audioMime: audioBlob.type || "audio/mpeg",
    audio: audioBlob,
    sentences: sentences.map((s, i) => ({
      i,
      start: Math.round(s.start * 1000) / 1000,
      end: Math.round(s.end * 1000) / 1000,
      it: s.text,
      zh: zh[i] || "",
    })),
  };
  try {
    await putLesson(lesson);
    workLog("已保存到本机 IndexedDB，下次打开这个网站即可离线回看。");
  } catch (e) {
    workLog("保存失败（可能是存储空间不足）：" + ((e && e.message) || e));
  }
  setWork("完成", `${lesson.sentences.length} 句 · ${fmtDur(lesson.duration)}`, 100);
  await openLesson(lesson.id, lesson);
}

/* ---------------- player ---------------- */
function fmt(t) {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return m + ":" + String(s).padStart(2, "0");
}
function fmtDur(t) {
  if (!t && t !== 0) return "";
  if (t < 60) return Math.round(t) + " 秒";
  return Math.floor(t / 60) + " 分 " + Math.round(t % 60) + " 秒";
}
function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(0) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}

async function openLesson(id, preloaded) {
  const lesson = preloaded || (await getLesson(id));
  if (!lesson) { alert("找不到这堂课"); return; }
  currentLesson = lesson;
  if (currentAudioUrl) URL.revokeObjectURL(currentAudioUrl);
  currentAudioUrl = lesson.audio ? URL.createObjectURL(lesson.audio) : "";
  $("orig").src = currentAudioUrl || "";
  $("playerTitle").textContent = lesson.title || "意大利语跟读";
  $("playerMeta").textContent = [
    (lesson.sentences || []).length + " 句",
    fmtDur(lesson.duration),
    "意大利语 → 简体中文",
  ].filter(Boolean).join(" · ");
  showView("player");
  if (playerCtl && playerCtl.destroy) playerCtl.destroy();
  playerCtl = attachPlayer(lesson, currentAudioUrl);
}

function attachPlayer(lesson, audioSrc) {
  const sentences = lesson.sentences || [];
  const storageKey = "miraa:" + (lesson.id || "lesson");
  const listEl = $("list");
  const orig = $("orig");
  const mine = $("mine");
  const pbar = $("pbar");
  const nowIt = $("nowIt");
  const btnPlay = $("btnPlay");
  const btnLoop = $("btnLoop");
  const btnLoop2 = $("btnLoop2");
  const btnZh = $("btnZh");
  const btnFavFilter = $("btnFavFilter");
  const btnRec = $("btnRec");
  const speedEl = $("speed");

  let state = { last: 0, favorites: [], hideZh: false };
  try { state = Object.assign(state, JSON.parse(localStorage.getItem(storageKey) || "{}")); } catch (e) {}
  let idx = Math.min(Math.max(0, state.last | 0), Math.max(0, sentences.length - 1));
  let looping = false;
  let favOnly = false;
  let playing = false;
  let comparing = false;
  let recorder = null;
  let recStream = null;
  const recUrls = {};
  const handlers = [];

  const on = (el, ev, fn) => { el.addEventListener(ev, fn); handlers.push([el, ev, fn]); };

  if (state.hideZh) setHideZh(true, false);
  renderList();
  select(idx, { play: false, scroll: true });
  layoutBar();
  const onResize = () => layoutBar();
  window.addEventListener("resize", onResize);

  function layoutBar() {
    $("bar").style.display = "block";
    document.documentElement.style.setProperty("--bar-h", $("bar").offsetHeight + "px");
  }
  function save() {
    state.last = idx;
    try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch (e) {}
  }
  function isFav(i) { return state.favorites.indexOf(i) >= 0; }
  function toggleFav(i, ev) {
    if (ev) ev.stopPropagation();
    const pos = state.favorites.indexOf(i);
    if (pos >= 0) state.favorites.splice(pos, 1);
    else state.favorites.push(i);
    save();
    renderList();
  }
  function renderList() {
    const frag = document.createDocumentFragment();
    let shown = 0;
    sentences.forEach((s, i) => {
      if (favOnly && !isFav(i)) return;
      shown++;
      const el = document.createElement("article");
      el.className = "sentence" + (i === idx ? " current" : "") + (isFav(i) ? " fav" : "") + (recUrls[i] ? " has-rec" : "");
      el.dataset.i = i;
      el.innerHTML =
        '<div class="s-top"><span class="idx"></span><button type="button" class="star" aria-label="收藏"></button></div>' +
        '<div class="it"></div><div class="zh"></div>' +
        '<div class="hide-note">译文已隐藏，点「显示译文」查看</div>' +
        '<div class="rec-row"><button type="button" class="play-mine">播放我的录音</button>' +
        '<button type="button" class="cmp">对比：先原音再我的</button></div>';
      el.querySelector(".idx").textContent = (i + 1) + " / " + sentences.length + " · " + fmt(s.start);
      el.querySelector(".star").textContent = isFav(i) ? "★" : "☆";
      el.querySelector(".it").textContent = s.it || "";
      el.querySelector(".zh").textContent = s.zh || "";
      if (!recUrls[i]) {
        el.querySelector(".play-mine").disabled = true;
        el.querySelector(".cmp").disabled = true;
      }
      el.addEventListener("click", () => select(i, { play: true, scroll: false }));
      el.querySelector(".star").addEventListener("click", (e) => toggleFav(i, e));
      el.querySelector(".play-mine").addEventListener("click", (e) => { e.stopPropagation(); playMine(i); });
      el.querySelector(".cmp").addEventListener("click", (e) => { e.stopPropagation(); compare(i); });
      frag.appendChild(el);
    });
    listEl.innerHTML = "";
    if (!shown) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = favOnly ? "还没有收藏的句子。点句子右上角的星星即可收藏。" : "没有句子。";
      listEl.appendChild(empty);
    } else listEl.appendChild(frag);
  }
  function currentEl() { return listEl.querySelector('.sentence[data-i="' + idx + '"]'); }
  function select(i, opts) {
    opts = opts || {};
    if (i < 0 || i >= sentences.length) return;
    idx = i;
    save();
    nowIt.textContent = sentences[i].it || "";
    document.querySelectorAll("#list .sentence").forEach((el) => {
      el.classList.toggle("current", Number(el.dataset.i) === i);
    });
    if (opts.scroll) {
      const el = currentEl();
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    pbar.style.width = "0%";
    if (opts.play) playCurrent();
  }
  function playCurrent() {
    const s = sentences[idx];
    if (!audioSrc || !s) return;
    comparing = false;
    orig.pause();
    mine.pause();
    orig.playbackRate = Number(speedEl.value) || 1;
    const start = Math.max(0, s.start);
    const seek = () => {
      try { orig.currentTime = start; } catch (e) {}
      orig.play().then(() => { playing = true; syncPlayBtn(); }).catch(() => { playing = false; syncPlayBtn(); });
    };
    if (orig.readyState >= 1) seek();
    else orig.addEventListener("loadedmetadata", seek, { once: true });
  }
  function pauseAll() {
    playing = false;
    comparing = false;
    orig.pause();
    mine.pause();
    syncPlayBtn();
  }
  function syncPlayBtn() { btnPlay.textContent = playing ? "⏸" : "▶"; }
  function setLoop(on) {
    looping = on;
    btnLoop.classList.toggle("on", on);
    btnLoop2.classList.toggle("on", on);
    btnLoop.textContent = on ? "循环中" : "循环本句";
  }
  function setHideZh(on, persist) {
    document.body.classList.toggle("hide-zh", on);
    btnZh.setAttribute("aria-pressed", on ? "false" : "true");
    btnZh.textContent = on ? "显示译文" : "隐藏译文";
    if (persist !== false) { state.hideZh = on; save(); }
  }

  function onTime() {
    const s = sentences[idx];
    if (!s || !playing) return;
    const start = s.start;
    const end = Math.max(s.end, start + 0.2);
    const t = orig.currentTime;
    pbar.style.width = Math.min(100, Math.max(0, ((t - start) / (end - start)) * 100)) + "%";
    if (t >= end - 0.04) {
      if (looping && !comparing) {
        orig.currentTime = start;
        orig.play().catch(() => {});
      } else if (comparing && recUrls[idx]) {
        orig.pause();
        playing = false;
        syncPlayBtn();
        playMine(idx);
        comparing = false;
      } else {
        orig.pause();
        playing = false;
        pbar.style.width = "100%";
        syncPlayBtn();
      }
    }
  }
  function onEnded() {
    if (looping) playCurrent();
    else { playing = false; syncPlayBtn(); }
  }
  on(orig, "timeupdate", onTime);
  on(orig, "ended", onEnded);
  on(btnPlay, "click", () => { if (playing) pauseAll(); else playCurrent(); });
  on($("btnPrev"), "click", () => select(favOnly ? nearestFav(idx, -1) : idx - 1, { play: true, scroll: true }));
  on($("btnNext"), "click", () => select(favOnly ? nearestFav(idx, 1) : idx + 1, { play: true, scroll: true }));
  function nearestFav(from, dir) {
    const favs = state.favorites.slice().sort((a, b) => a - b);
    if (!favs.length) return from;
    if (dir > 0) return favs.find((i) => i > from) ?? favs[0];
    const prev = favs.filter((i) => i < from);
    return prev.length ? prev[prev.length - 1] : favs[favs.length - 1];
  }
  on(btnLoop, "click", () => setLoop(!looping));
  on(btnLoop2, "click", () => setLoop(!looping));
  on(btnZh, "click", () => setHideZh(!document.body.classList.contains("hide-zh")));
  on(btnFavFilter, "click", () => {
    favOnly = !favOnly;
    btnFavFilter.setAttribute("aria-pressed", favOnly ? "true" : "false");
    renderList();
    const el = currentEl();
    if (el) el.scrollIntoView({ block: "center" });
  });
  on(speedEl, "change", () => { orig.playbackRate = Number(speedEl.value) || 1; });

  function playMine(i) {
    if (!recUrls[i]) return;
    orig.pause();
    playing = false;
    syncPlayBtn();
    mine.src = recUrls[i];
    mine.playbackRate = 1;
    mine.play().catch(() => {});
  }
  function compare(i) {
    select(i, { play: false, scroll: true });
    comparing = true;
    playCurrent();
  }
  function pickMime() {
    const types = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/aac", "audio/ogg;codecs=opus"];
    if (!window.MediaRecorder) return "";
    return types.find((t) => MediaRecorder.isTypeSupported(t)) || "";
  }
  async function toggleRec() {
    if (recorder && recorder.state === "recording") { recorder.stop(); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert("这个浏览器不支持录音。");
      return;
    }
    try { recStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { alert("无法打开麦克风：" + (e && e.message ? e.message : "被拒绝或不可用")); return; }
    const mime = pickMime();
    try { recorder = mime ? new MediaRecorder(recStream, { mimeType: mime }) : new MediaRecorder(recStream); }
    catch (e) { recStream.getTracks().forEach((t) => t.stop()); alert("无法开始录音。"); return; }
    const chunks = [];
    const recIdx = idx;
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      btnRec.classList.remove("rec-on");
      btnRec.textContent = "●";
      if (recStream) recStream.getTracks().forEach((t) => t.stop());
      recStream = null;
      recorder = null;
      if (!chunks.length) return;
      const blob = new Blob(chunks, { type: chunks[0].type || mime || "audio/webm" });
      if (recUrls[recIdx]) URL.revokeObjectURL(recUrls[recIdx]);
      recUrls[recIdx] = URL.createObjectURL(blob);
      putRec((lesson.id || "lesson") + ":" + recIdx, blob).catch(() => {});
      renderList();
    };
    recorder.start();
    btnRec.classList.add("rec-on");
    btnRec.textContent = "■";
  }
  on(btnRec, "click", toggleRec);

  // load saved recordings
  (async () => {
    for (let i = 0; i < sentences.length; i++) {
      try {
        const blob = await getRec((lesson.id || "lesson") + ":" + i);
        if (blob) recUrls[i] = URL.createObjectURL(blob);
      } catch (e) {}
    }
    renderList();
  })();

  return {
    destroy() {
      pauseAll();
      window.removeEventListener("resize", onResize);
      handlers.forEach(([el, ev, fn]) => el.removeEventListener(ev, fn));
      Object.values(recUrls).forEach((u) => URL.revokeObjectURL(u));
    },
  };
}

/* ---------------- export self-contained HTML ---------------- */
async function exportCurrentLesson() {
  if (!currentLesson) return;
  const L = currentLesson;
  setTimeout(() => {}, 0);
  const blob = L.audio;
  let audioSrc = "";
  if (blob) {
    const b64 = await blobToBase64(blob);
    const mime = L.audioMime || blob.type || "audio/mpeg";
    audioSrc = `data:${mime};base64,${b64}`;
  }
  const payload = {
    id: L.id,
    title: L.title,
    language: "it",
    translation: "zh-CN",
    duration: L.duration,
    created_at: new Date(L.createdAt || Date.now()).toISOString(),
    whisper_model: L.model,
    translation_method: L.translationMethod,
    sentences: L.sentences,
    audio_src: audioSrc,
    audio_mime: L.audioMime || "",
  };
  const html = EXPORT_TEMPLATE.replace("__LESSON_JSON__", JSON.stringify(payload));
  const safe = (L.title || "lesson").replace(/[^\w\u4e00-\u9fff\-]+/g, "_").slice(0, 60) || "lesson";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
  a.download = safe + ".html";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const s = String(fr.result || "");
      const i = s.indexOf(",");
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

/* A compact copy of the desktop export player (template.html). */
const EXPORT_TEMPLATE = `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#1f3a2e"><title>意大利语跟读</title>
<style>
:root{--bg:#f4efe6;--paper:#fffaf2;--ink:#1c241e;--muted:#6b6458;--line:#e4d8c4;--accent:#1f3a2e;--accent-2:#c45c26;--hl:#ffe7c2;--hl-border:#e8b86a;--shadow:0 8px 28px rgba(40,28,12,.08);--safe-bottom:env(safe-area-inset-bottom,0px);--bar-h:0px}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}html,body{margin:0;padding:0}
body{font-family:"PingFang SC","Noto Sans SC","Hiragino Sans GB","Microsoft YaHei",system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--ink);min-height:100dvh}
header{position:sticky;top:0;z-index:20;background:rgba(244,239,230,.92);backdrop-filter:blur(12px);border-bottom:1px solid var(--line);padding:calc(10px + env(safe-area-inset-top,0px)) 16px 10px}
.head-row{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
h1{font-size:1.05rem;line-height:1.35;margin:0;font-weight:700;max-width:70vw}
.meta{color:var(--muted);font-size:.78rem;margin-top:4px}
button{font:inherit;color:inherit;background:var(--paper);border:1px solid var(--line);border-radius:999px;padding:8px 12px;min-height:40px;cursor:pointer}
.icon-btn{min-width:40px;display:inline-flex;align-items:center;justify-content:center}
.icon-btn[aria-pressed="true"],button.on{background:var(--accent);color:#fff;border-color:var(--accent)}
.toolbar{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.toolbar button{font-size:.82rem;padding:6px 12px;min-height:36px}
main{padding:12px 14px calc(var(--bar-h) + 20px);max-width:720px;margin:0 auto}
.sentence{background:var(--paper);border:1px solid var(--line);border-radius:16px;padding:14px 14px 12px;margin:0 0 10px;box-shadow:var(--shadow);cursor:pointer}
.sentence.current{background:var(--hl);border-color:var(--hl-border);box-shadow:0 0 0 3px rgba(232,184,106,.25)}
.s-top{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px}
.idx{font-size:.72rem;color:var(--muted);font-variant-numeric:tabular-nums}
.star{border:0;background:transparent;font-size:1.15rem;min-height:36px;min-width:36px;padding:0;line-height:1;color:#c8b89a}
.sentence.fav .star{color:var(--accent-2)}
.it{font-size:1.22rem;line-height:1.5;font-weight:600;font-family:"Iowan Old Style","Palatino Linotype",Palatino,"Noto Serif",Georgia,serif}
.zh{margin-top:6px;color:var(--muted);font-size:.95rem;line-height:1.45}
body.hide-zh .zh{display:none}
.hide-note{display:none;color:var(--muted);font-size:.8rem;margin-top:6px}
body.hide-zh .sentence.current .hide-note{display:block}
.rec-row{display:none;gap:8px;margin-top:10px;align-items:center;flex-wrap:wrap}
.sentence.has-rec .rec-row,.sentence.current .rec-row{display:flex}
.rec-row button{font-size:.8rem;min-height:34px;padding:4px 10px}
.empty{text-align:center;color:var(--muted);padding:48px 12px}
#bar{position:fixed;left:0;right:0;bottom:0;z-index:30;background:#1f3a2e;color:#f7f1e6;padding:10px 12px calc(10px + var(--safe-bottom));box-shadow:0 -8px 30px rgba(0,0,0,.2)}
.progress{height:4px;background:rgba(255,255,255,.15);border-radius:99px;overflow:hidden;margin-bottom:10px}
.progress>span{display:block;height:100%;width:0;background:#f0c36a}
.now-it{font-size:.92rem;line-height:1.35;margin:0 2px 8px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.controls{display:flex;align-items:center;justify-content:space-between;gap:6px}
.controls button,.speed{background:rgba(255,255,255,.1);color:#fff;border:1px solid rgba(255,255,255,.16);border-radius:12px;min-height:44px;min-width:44px;padding:0 10px}
.controls button.on{background:#c45c26;border-color:#c45c26}
.controls button.rec-on{background:#b13333;border-color:#b13333;animation:pulse 1s infinite}
@keyframes pulse{50%{opacity:.7}}
.mid{display:flex;gap:6px;align-items:center}
.speed{font:inherit;appearance:none;-webkit-appearance:none;padding:0 8px;text-align:center}
.warn{background:#fff1e4;color:#7a3a10;border:1px solid #f0c9a0;border-radius:12px;padding:10px 12px;margin:0 0 12px;font-size:.86rem}
audio{display:none}
</style></head><body>
<header><div class="head-row"><div><h1 id="title">意大利语跟读</h1><div class="meta" id="meta"></div></div>
<div class="toggles"><button class="icon-btn" id="btnFavFilter" aria-pressed="false" title="只看收藏">★</button></div></div>
<div class="toolbar"><button type="button" id="btnZh" aria-pressed="true">隐藏译文</button><button type="button" id="btnLoop">循环本句</button></div></header>
<main><div id="secureNote" class="warn" hidden>当前页面不是安全环境，麦克风录音可能不可用。跟读播放通常仍可用。</div>
<div id="noAudio" class="warn" hidden>本课没有嵌入音频。</div><div id="list"></div></main>
<div id="bar"><div class="progress" aria-hidden="true"><span id="pbar"></span></div>
<div class="now-it" id="nowIt">点选一句开始跟读</div>
<div class="controls"><button type="button" id="btnPrev">‹ 上一句</button>
<div class="mid"><button type="button" id="btnPlay">▶ 播放</button><button type="button" id="btnLoop2">🔁</button>
<select class="speed" id="speed"><option value="0.5">0.5×</option><option value="0.75">0.75×</option><option value="1" selected>1.0×</option><option value="1.25">1.25×</option></select>
<button type="button" id="btnRec">● 录音</button></div>
<button type="button" id="btnNext">下一句 ›</button></div></div>
<audio id="orig" playsinline></audio><audio id="mine" playsinline></audio>
<script>
const LESSON = __LESSON_JSON__;
(function(){
  const sentences=LESSON.sentences||[];
  const storageKey="miraa:"+(LESSON.id||"lesson");
  const listEl=document.getElementById("list"), orig=document.getElementById("orig"), mine=document.getElementById("mine");
  const pbar=document.getElementById("pbar"), nowIt=document.getElementById("nowIt");
  const btnPlay=document.getElementById("btnPlay"), btnLoop=document.getElementById("btnLoop"), btnLoop2=document.getElementById("btnLoop2");
  const btnZh=document.getElementById("btnZh"), btnFavFilter=document.getElementById("btnFavFilter"), btnRec=document.getElementById("btnRec"), speedEl=document.getElementById("speed");
  document.getElementById("title").textContent=LESSON.title||"意大利语跟读";
  document.title=(LESSON.title||"意大利语跟读")+" · 跟读";
  function fmt(t){t=Math.max(0,t||0);const m=Math.floor(t/60),s=Math.floor(t%60);return m+":"+String(s).padStart(2,"0")}
  document.getElementById("meta").textContent=[sentences.length+" 句", LESSON.duration?fmt(LESSON.duration):"","意大利语 → 简体中文"].filter(Boolean).join(" · ");
  if(LESSON.audio_src) orig.src=LESSON.audio_src; else document.getElementById("noAudio").hidden=false;
  if(!(window.isSecureContext||location.protocol==="https:"||location.hostname==="localhost")) document.getElementById("secureNote").hidden=false;
  let state={last:0,favorites:[],hideZh:false};
  try{state=Object.assign(state,JSON.parse(localStorage.getItem(storageKey)||"{}"))}catch(e){}
  let idx=Math.min(Math.max(0,state.last|0),Math.max(0,sentences.length-1));
  let looping=false,favOnly=false,playing=false,comparing=false,recorder=null,recStream=null;
  const recUrls={};
  if(state.hideZh) setHideZh(true,false);
  renderList(); select(idx,{play:false,scroll:true}); layoutBar();
  window.addEventListener("resize",layoutBar);
  function layoutBar(){document.documentElement.style.setProperty("--bar-h",document.getElementById("bar").offsetHeight+"px")}
  function save(){state.last=idx;try{localStorage.setItem(storageKey,JSON.stringify(state))}catch(e){}}
  function isFav(i){return state.favorites.indexOf(i)>=0}
  function toggleFav(i,ev){if(ev)ev.stopPropagation();const p=state.favorites.indexOf(i);if(p>=0)state.favorites.splice(p,1);else state.favorites.push(i);save();renderList()}
  function renderList(){
    const frag=document.createDocumentFragment(); let shown=0;
    sentences.forEach((s,i)=>{
      if(favOnly&&!isFav(i))return; shown++;
      const el=document.createElement("article");
      el.className="sentence"+(i===idx?" current":"")+(isFav(i)?" fav":"")+(recUrls[i]?" has-rec":"");
      el.dataset.i=i;
      el.innerHTML='<div class="s-top"><span class="idx">'+(i+1)+" / "+sentences.length+" · "+fmt(s.start)+'</span><button type="button" class="star">'+(isFav(i)?"★":"☆")+"</button></div><div class=\\"it\\"></div><div class=\\"zh\\"></div><div class=\\"hide-note\\">译文已隐藏，点「显示译文」查看</div><div class=\\"rec-row\\"><button type=\\"button\\" class=\\"play-mine\\""+(recUrls[i]?"":" disabled")+">播放我的录音</button><button type=\\"button\\" class=\\"cmp\\""+(recUrls[i]?"":" disabled")+">对比：先原音再我的</button></div>";
      el.querySelector(".it").textContent=s.it||""; el.querySelector(".zh").textContent=s.zh||"";
      el.addEventListener("click",()=>select(i,{play:true,scroll:false}));
      el.querySelector(".star").addEventListener("click",e=>toggleFav(i,e));
      el.querySelector(".play-mine").addEventListener("click",e=>{e.stopPropagation();playMine(i)});
      el.querySelector(".cmp").addEventListener("click",e=>{e.stopPropagation();compare(i)});
      frag.appendChild(el);
    });
    listEl.innerHTML="";
    if(!shown){const empty=document.createElement("div");empty.className="empty";empty.textContent=favOnly?"还没有收藏的句子。":"没有句子。";listEl.appendChild(empty)}
    else listEl.appendChild(frag);
  }
  function currentEl(){return listEl.querySelector('.sentence[data-i="'+idx+'"]')}
  function select(i,opts){opts=opts||{};if(i<0||i>=sentences.length)return;idx=i;save();nowIt.textContent=sentences[i].it||"";
    document.querySelectorAll(".sentence").forEach(el=>el.classList.toggle("current",Number(el.dataset.i)===i));
    if(opts.scroll){const el=currentEl();if(el)el.scrollIntoView({behavior:"smooth",block:"center"})}
    pbar.style.width="0%"; if(opts.play)playCurrent();
  }
  function playCurrent(){const s=sentences[idx];if(!LESSON.audio_src||!s)return;comparing=false;orig.pause();mine.pause();orig.playbackRate=Number(speedEl.value)||1;
    const start=Math.max(0,s.start); const seek=()=>{try{orig.currentTime=start}catch(e){} orig.play().then(()=>{playing=true;sync()}).catch(()=>{playing=false;sync()})};
    if(orig.readyState>=1)seek(); else orig.addEventListener("loadedmetadata",seek,{once:true});
  }
  function pauseAll(){playing=false;comparing=false;orig.pause();mine.pause();sync()}
  function sync(){btnPlay.textContent=playing?"⏸ 暂停":"▶ 播放"}
  function setLoop(on){looping=on;btnLoop.classList.toggle("on",on);btnLoop2.classList.toggle("on",on);btnLoop.textContent=on?"循环中":"循环本句"}
  function setHideZh(on,persist){document.body.classList.toggle("hide-zh",on);btnZh.setAttribute("aria-pressed",on?"false":"true");btnZh.textContent=on?"显示译文":"隐藏译文";if(persist!==false){state.hideZh=on;save()}}
  orig.addEventListener("timeupdate",()=>{const s=sentences[idx];if(!s||!playing)return;const start=s.start,end=Math.max(s.end,start+0.2),t=orig.currentTime;
    pbar.style.width=Math.min(100,Math.max(0,((t-start)/(end-start))*100))+"%";
    if(t>=end-0.04){if(looping&&!comparing){orig.currentTime=start;orig.play().catch(()=>{})}
      else if(comparing&&recUrls[idx]){orig.pause();playing=false;sync();playMine(idx);comparing=false}
      else{orig.pause();playing=false;pbar.style.width="100%";sync()}}
  });
  orig.addEventListener("ended",()=>{if(looping)playCurrent();else{playing=false;sync()}});
  btnPlay.addEventListener("click",()=>{if(playing)pauseAll();else playCurrent()});
  function nearestFav(from,dir){const favs=state.favorites.slice().sort((a,b)=>a-b);if(!favs.length)return from;if(dir>0)return favs.find(i=>i>from)??favs[0];const prev=favs.filter(i=>i<from);return prev.length?prev[prev.length-1]:favs[favs.length-1]}
  document.getElementById("btnPrev").addEventListener("click",()=>select(favOnly?nearestFav(idx,-1):idx-1,{play:true,scroll:true}));
  document.getElementById("btnNext").addEventListener("click",()=>select(favOnly?nearestFav(idx,1):idx+1,{play:true,scroll:true}));
  btnLoop.addEventListener("click",()=>setLoop(!looping)); btnLoop2.addEventListener("click",()=>setLoop(!looping));
  btnZh.addEventListener("click",()=>setHideZh(!document.body.classList.contains("hide-zh")));
  btnFavFilter.addEventListener("click",()=>{favOnly=!favOnly;btnFavFilter.setAttribute("aria-pressed",favOnly?"true":"false");renderList();const el=currentEl();if(el)el.scrollIntoView({block:"center"})});
  speedEl.addEventListener("change",()=>{orig.playbackRate=Number(speedEl.value)||1});
  function playMine(i){if(!recUrls[i])return;orig.pause();playing=false;sync();mine.src=recUrls[i];mine.play().catch(()=>{})}
  function compare(i){select(i,{play:false,scroll:true});comparing=true;playCurrent()}
  function pickMime(){const types=["audio/webm;codecs=opus","audio/webm","audio/mp4","audio/aac"];if(!window.MediaRecorder)return"";return types.find(t=>MediaRecorder.isTypeSupported(t))||""}
  btnRec.addEventListener("click",async()=>{
    if(recorder&&recorder.state==="recording"){recorder.stop();return}
    if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){alert("这个浏览器不支持录音。");return}
    try{recStream=await navigator.mediaDevices.getUserMedia({audio:true})}catch(e){alert("无法打开麦克风");return}
    const mime=pickMime();
    try{recorder=mime?new MediaRecorder(recStream,{mimeType:mime}):new MediaRecorder(recStream)}catch(e){recStream.getTracks().forEach(t=>t.stop());alert("无法开始录音。");return}
    const chunks=[]; const recIdx=idx;
    recorder.ondataavailable=e=>{if(e.data&&e.data.size)chunks.push(e.data)};
    recorder.onstop=()=>{btnRec.classList.remove("rec-on");btnRec.textContent="● 录音";if(recStream)recStream.getTracks().forEach(t=>t.stop());recStream=null;recorder=null;
      if(!chunks.length)return;const blob=new Blob(chunks,{type:chunks[0].type||mime||"audio/webm"});if(recUrls[recIdx])URL.revokeObjectURL(recUrls[recIdx]);recUrls[recIdx]=URL.createObjectURL(blob);renderList()};
    recorder.start();btnRec.classList.add("rec-on");btnRec.textContent="■ 停止";
  });
})();
</script></body></html>`;

/* ---------------- boot ---------------- */
function boot() {
  if (!isSecure()) $("secureNote").hidden = false;
  try {
    const saved = localStorage.getItem("miraa-phone-model");
    if (saved && MODELS[saved]) modelSel.value = saved;
  } catch (e) {}
  modelSel.addEventListener("change", () => {
    try { localStorage.setItem("miraa-phone-model", modelSel.value); } catch (e) {}
  });
  $("btnPick").addEventListener("click", () => filePick.click());
  filePick.addEventListener("change", () => {
    const f = filePick.files && filePick.files[0];
    filePick.value = "";
    if (f) processFile(f);
  });
  $("btnCancelWork").addEventListener("click", () => {
    cancelled = true;
    showView("lib");
    refreshLibrary();
  });
  $("btnBack").addEventListener("click", () => {
    if (playerCtl && playerCtl.destroy) playerCtl.destroy();
    playerCtl = null;
    if (currentAudioUrl) { URL.revokeObjectURL(currentAudioUrl); currentAudioUrl = null; }
    currentLesson = null;
    $("orig").removeAttribute("src");
    showView("lib");
    refreshLibrary();
  });
  $("btnExport").addEventListener("click", () => exportCurrentLesson());
  refreshLibrary();

  // Expose a small hook for automated tests (localhost only).
  window.__miraa = {
    processFile,
    listLessons,
    getLesson,
    openLesson,
  };
}

boot();
