/* 外语跟读 — phone-only app (library, in-browser Whisper, player, export). */
const MODEL_CATALOG = {
  "onnx-community/whisper-tiny": { label: "whisper-tiny", downloadMB: 43 },
  "onnx-community/whisper-base": { label: "whisper-base", downloadMB: 77 },
  "onnx-community/whisper-small": { label: "whisper-small", downloadMB: 242 },
  "onnx-community/whisper-tiny.en": { label: "whisper-tiny.en", downloadMB: 43, enOnly: true },
  "onnx-community/whisper-base.en": { label: "whisper-base.en", downloadMB: 77, enOnly: true },
};
const MULTI_TINY = "onnx-community/whisper-tiny";
const MULTI_BASE = "onnx-community/whisper-base";
const MULTI_SMALL = "onnx-community/whisper-small";
const EN_TINY = "onnx-community/whisper-tiny.en";
const EN_BASE = "onnx-community/whisper-base.en";
const MULTI_FALLBACK = { [MULTI_SMALL]: MULTI_BASE, [MULTI_BASE]: MULTI_TINY };
const LANGS = {
  it: {
    id: "it", name: "意大利语", whisper: "italian", sl: "it", wikt: "it",
    tiny: MULTI_TINY, models: [MULTI_TINY, MULTI_BASE, MULTI_SMALL], fallback: MULTI_FALLBACK,
    fillers: "eh→唉/呃，beh→嗯/好吧，dai→快点/得了",
  },
  en: {
    id: "en", name: "英语", whisper: "english", sl: "en", wikt: "en",
    tiny: EN_TINY, models: [EN_TINY, EN_BASE, MULTI_TINY, MULTI_BASE, MULTI_SMALL],
    fallback: { [MULTI_SMALL]: EN_BASE, [MULTI_BASE]: EN_TINY, [EN_BASE]: EN_TINY, [EN_TINY]: MULTI_TINY },
    fillers: "uh/um→呃，oh→哦，well→嗯/好吧，like→就是",
  },
  ja: {
    id: "ja", name: "日语", whisper: "japanese", sl: "ja", wikt: "ja",
    tiny: MULTI_TINY, models: [MULTI_TINY, MULTI_BASE, MULTI_SMALL], fallback: MULTI_FALLBACK,
    fillers: "あの→那个，えっと→呃，まあ→嗯",
  },
};
const LANG_IDS = ["it", "en", "ja"];
let curLang = "it";
const langCfg = () => LANGS[curLang] || LANGS.it;
const srcName = () => langCfg().name;
const srcCode = () => langCfg().sl;
const MODELS = MODEL_CATALOG;
function fallbackOf(m) {
  const L = langCfg();
  return (L.fallback && L.fallback[m]) || L.tiny || MULTI_TINY;
}
function lsKey(suffix, lang = curLang) { return "miraa-" + lang + "-" + suffix; }
const RATE = 16000;
const CJK_RE = /[\u4e00-\u9fff]/;
function sentEndRe(lang = curLang) {
  return lang === "ja" ? /([。！？!?…]+)/ : /([.!?…]+)(?:\s+|$)/;
}
const SENT_END_RE = sentEndRe("it");

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
const DB_VER = 1;
const dbCache = {};
function dbNameFor(lang = curLang) { return "miraa-phone-" + lang; }
function openDbNamed(name) {
  if (dbCache[name]) return Promise.resolve(dbCache[name]);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("lessons")) db.createObjectStore("lessons", { keyPath: "id" });
      if (!db.objectStoreNames.contains("recordings")) db.createObjectStore("recordings");
    };
    req.onsuccess = () => { dbCache[name] = req.result; resolve(req.result); };
    req.onerror = () => reject(req.error);
  });
}
const openDb = (lang = curLang) => openDbNamed(dbNameFor(lang));

async function idbOpOn(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbOp(store, mode, fn) {
  const db = await openDb();
  return idbOpOn(db, store, mode, fn);
}

const listLessons = () => idbOp("lessons", "readonly", (s) => s.getAll());
const getLesson = (id) => idbOp("lessons", "readonly", (s) => s.get(id));
const putLesson = (lesson) => idbOp("lessons", "readwrite", (s) => s.put(lesson));
const delLesson = (id) => idbOp("lessons", "readwrite", (s) => s.delete(id));
const putRec = (key, blob) => idbOp("recordings", "readwrite", (s) => s.put(blob, key));
const getRec = (key) => idbOp("recordings", "readonly", (s) => s.get(key));

async function copyStore(src, dest, store, keyed) {
  if (!src.objectStoreNames.contains(store) || !dest.objectStoreNames.contains(store)) return 0;
  const items = await idbOpOn(src, store, "readonly", (s) => s.getAll()) || [];
  const keys = keyed ? (await idbOpOn(src, store, "readonly", (s) => s.getAllKeys()) || []) : null;
  for (let i = 0; i < items.length; i++) {
    await idbOpOn(dest, store, "readwrite", (s) => keyed ? s.put(items[i], keys[i]) : s.put(items[i]));
  }
  return items.length;
}
async function migrateItalianIfNeeded() {
  const flag = "miraa-it-migrated-v1";
  try { if (localStorage.getItem(flag)) return; } catch (e) {}
  try {
    let hasLegacy = false;
    if (indexedDB.databases) {
      try { hasLegacy = (await indexedDB.databases()).some((d) => d && d.name === "miraa-phone"); } catch (e) {}
    } else hasLegacy = true;
    const legacy = hasLegacy ? await new Promise((resolve) => {
      const r = indexedDB.open("miraa-phone");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
    }) : null;
    const dest = await openDbNamed("miraa-phone-it");
    const existing = dest.objectStoreNames.contains("lessons") ? (await idbOpOn(dest, "lessons", "readonly", (s) => s.getAll()) || []) : [];
    const real = existing.filter((x) => x && x.id !== "__job__");
    if (legacy && legacy.objectStoreNames.contains("lessons") && real.length === 0) {
      const nL = await copyStore(legacy, dest, "lessons", false);
      const nR = await copyStore(legacy, dest, "recordings", true);
      dbg("已把原来的课迁移到意大利语（" + nL + " 课，" + nR + " 条录音）");
    }
    const pairs = [["miraa-vocab", "miraa-it-vocab"], ["miraa-phone-model", "miraa-it-model"], ["miraa-loading-model", "miraa-it-loading-model"], ["miraa-submode", "miraa-it-submode"]];
    for (const [o, n] of pairs) {
      try { if (localStorage.getItem(n) == null && localStorage.getItem(o) != null) localStorage.setItem(n, localStorage.getItem(o)); } catch (e) {}
    }
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
      for (const k of keys) {
        if (!k) continue;
        if (k.startsWith("miraa-confirmed-")) {
          const n = "miraa-it-confirmed-" + k.slice("miraa-confirmed-".length);
          if (localStorage.getItem(n) == null) localStorage.setItem(n, localStorage.getItem(k));
        } else if (k.startsWith("miraa:") && !k.startsWith("miraa-it:") && !k.startsWith("miraa-en:") && !k.startsWith("miraa-ja:")) {
          const n = "miraa-it:" + k.slice("miraa:".length);
          if (localStorage.getItem(n) == null) localStorage.setItem(n, localStorage.getItem(k));
        }
      }
    } catch (e) {}
  } catch (e) { try { dbg("迁移旧数据时出错：" + ((e && e.message) || e)); } catch (e2) {} }
  try { localStorage.setItem(flag, "1"); } catch (e) {}
}

/* ---------------- library ---------------- */
async function refreshLibrary() {
  const box = $("libList");
  let items = [];
  try { items = (await listLessons()) || [];
  items = items.filter((x) => x.id !== JOB_ID); } catch (e) { items = []; }
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
  fromRate = Number(fromRate); toRate = Number(toRate);
  if (!fromRate || !toRate || fromRate === toRate) return input;
  const destLen = Math.max(1, Math.round(input.length * toRate / fromRate));
  const out = new Float32Array(destLen);
  const ratio = fromRate / toRate; // exact sample-rate ratio, not destLen rounding
  for (let i = 0; i < destLen; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = x - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

const TINY = MULTI_TINY, BASE = MULTI_BASE, SMALL = MULTI_SMALL;
const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
function loadingKey() { return lsKey("loading-model"); }
function modelKey() { return lsKey("model"); }
function confirmKey(m) { return lsKey("confirmed-" + m); }

/* ---------------- persistent debug log ---------------- */
const DBG_KEY = "miraa-debug";
function dbg(step) {
  let arr = [];
  try { arr = JSON.parse(localStorage.getItem(DBG_KEY) || "[]"); } catch (e) {}
  const t = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  let mem = "";
  try { if (performance.memory) mem = " mem=" + Math.round(performance.memory.usedJSHeapSize / 1048576) + "MB"; } catch (e) {}
  arr.push(`[${t}] ${step}${mem}`);
  arr = arr.slice(-60);
  try { localStorage.setItem(DBG_KEY, JSON.stringify(arr)); } catch (e) {}
  renderDebug();
}
function renderDebug() {
  const el = document.getElementById("debugLog");
  if (!el) return;
  let arr = [];
  try { arr = JSON.parse(localStorage.getItem(DBG_KEY) || "[]"); } catch (e) {}
  el.textContent = arr.length ? arr.join("\n") : "（暂无记录）";
}

async function decodeArrayBuffer(ab) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx(); // default rate: iOS is unreliable with custom sampleRate
  try {
    return await new Promise((resolve, reject) => {
      const p = ctx.decodeAudioData(ab, resolve, reject);
      if (p && p.then) p.then(resolve, reject);
    });
  } finally {
    try { await ctx.close(); } catch (e) {}
  }
}

/* Fallback: play the media muted-to-speakers through a <video> element and capture samples. */
async function captureViaMediaElement(file, onProgress) {
  const url = URL.createObjectURL(file);
  const media = document.createElement("video");
  media.playsInline = true;
  media.setAttribute("playsinline", "");
  media.preload = "auto";
  media.src = url;
  await new Promise((res, rej) => {
    media.onloadedmetadata = res;
    media.onerror = () => rej(new Error("浏览器无法读取这个视频"));
  });
  const dur = media.duration;
  if (!isFinite(dur) || dur <= 0) throw new Error("无法读取时长");
  if (dur > 15 * 60) throw new Error("视频超过 15 分钟，手机上无法实时提取");
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  const src = ctx.createMediaElementSource(media);
  const proc = ctx.createScriptProcessor(4096, 2, 1);
  const parts = [];
  proc.onaudioprocess = (e) => {
    const ib = e.inputBuffer;
    const n = ib.length, ch = ib.numberOfChannels;
    const m = new Float32Array(n);
    for (let c = 0; c < ch; c++) { const d = ib.getChannelData(c); for (let i = 0; i < n; i++) m[i] += d[i] / ch; }
    parts.push(m); // keep native ctx.sampleRate; resample once at the end
    if (onProgress) onProgress(media.currentTime / dur);
  };
  const mute = ctx.createGain(); mute.gain.value = 0;
  src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
  await ctx.resume();
  await media.play();
  await new Promise((res) => { media.onended = res; });
  proc.disconnect(); src.disconnect();
  try { await ctx.close(); } catch (e) {}
  URL.revokeObjectURL(url);
  let len = 0; parts.forEach((p) => (len += p.length));
  const raw = new Float32Array(len); let o = 0;
  parts.forEach((p) => { raw.set(p, o); o += p.length; });
  return resampleLinear(raw, ctx.sampleRate, RATE);
}

async function decodeTo16kMono(file, onProgress) {
  dbg("解码开始：" + (file.type || "?") + " " + fmtBytes(file.size));
  let buf = null;
  try {
    let ab = await file.arrayBuffer();
    dbg("已读入文件");
    buf = await decodeArrayBuffer(ab);
    ab = null;
    dbg(`decodeAudioData 成功 ${buf.sampleRate}Hz ${buf.numberOfChannels}声道`);
  } catch (e) {
    dbg("decodeAudioData 失败：" + ((e && e.message) || e) + "，改用视频播放提取");
    buf = null;
  }
  if (buf) {
    const ch = buf.numberOfChannels, n = buf.length, rate = buf.sampleRate;
    const mono = new Float32Array(n);
    for (let c = 0; c < ch; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[i] / ch; }
    buf = null;
    const pcm = resampleLinear(mono, rate, RATE);
    return { pcm, duration: n / rate, sourceRate: rate };
  }
  const pcm = await captureViaMediaElement(file, onProgress);
  dbg("视频播放提取完成");
  return { pcm, duration: pcm.length / RATE, sourceRate: RATE };
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
function tokenizeText(text, lang = curLang) {
  text = String(text || "");
  if (lang === "ja" && typeof Intl !== "undefined" && Intl.Segmenter) {
    try {
      return [...new Intl.Segmenter("ja", { granularity: "word" }).segment(text)].map((s) => ({ t: s.segment, word: !!s.isWordLike }));
    } catch (e) {}
  }
  return text.split(/(\s+)/).map((tok) => ({ t: tok, word: !!tok && !/^\s+$/.test(tok) }));
}
function isSentenceEnd(text, lang = curLang) {
  const t = String(text || "").trim();
  if (!sentEndRe(lang).test(t)) return false;
  if (lang === "ja") return t.replace(/[。！？!?…\s]/g, "").length >= 2;
  return t.split(/\s+/).length >= 2;
}
function splitSentencesInText(text, lang = curLang) {
  text = String(text || "").replace(/\s+/g, lang === "ja" ? "" : " ").trim();
  if (!text) return [];
  const parts = [];
  let last = 0;
  const re = new RegExp(sentEndRe(lang).source, "g");
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
      text: buf.map((s) => s.text).join(curLang === "ja" ? "" : " ").replace(/\s+/g, curLang === "ja" ? "" : " ").trim(),
    });
    buf = [];
  };
  for (const seg of split) {
    if (!buf.length) {
      buf = [seg];
      if (isSentenceEnd(seg.text)) flush();
      continue;
    }
    const span = seg.end - buf[0].start;
    const gap = seg.start - buf[buf.length - 1].end;
    const wordLike = buf.every((x) => (x.end - x.start) < 1.6 || (x.text || "").trim().split(/\s+/).length <= 3);
    if (gap > (wordLike ? 0.7 : 1.2) || span > 18) {
      flush();
      buf = [seg];
    } else buf.push(seg);
    if (buf.length && isSentenceEnd(buf[buf.length - 1].text)) flush();
  }
  flush();
  return merged.filter((s) => s.text && !/^[.!?。！？…]+$/.test(s.text)).map((s) => ({
    start: s.start,
    end: s.end > s.start ? s.end : s.start + 0.6,
    text: s.text,
  }));
}

/* ---------------- translation ---------------- */
let toSimp = (x) => x;
try { if (window.OpenCC) toSimp = OpenCC.Converter({ from: "tw", to: "cn" }); } catch (e) {}
const okZh = (z) => !!z && CJK_RE.test(z);

async function googleBatch(lines) {
  const url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=" + srcCode() + "&tl=zh-CN&dt=t&q=" + encodeURIComponent(lines.join("\n"));
  const r = await fetch(url);
  if (!r.ok) throw new Error("Google HTTP " + r.status);
  const d = await r.json();
  const full = (d[0] || []).map((x) => x[0] || "").join("");
  const out = full.split("\n").map((x) => x.trim());
  if (out.length !== lines.length) throw new Error("行数不一致");
  return out;
}
async function myMemory(text) {
  const url = "https://api.mymemory.translated.net/get?" + new URLSearchParams({ q: text, langpair: srcCode() + "|zh-CN" });
  const r = await fetch(url);
  if (!r.ok) throw new Error("HTTP " + r.status);
  const d = await r.json();
  const z = ((d.responseData || {}).translatedText || "").trim();
  return z.includes("MYMEMORY WARNING") ? "" : z;
}
async function translateOne(text) {
  try { const [z] = await googleBatch([text]); if (okZh(z)) return toSimp(z); } catch (e) {}
  try { const z = await myMemory(text); if (okZh(z)) return toSimp(z); } catch (e) {}
  return "";
}
/* ---- free no-key LLM (Pollinations, OpenAI-compatible, CORS *) ---- */
const AI_URL = "https://text.pollinations.ai/openai";
let aiQueue = Promise.resolve(), lastAiAt = 0;
function aiChat(prompt, timeoutMs) {
  const run = aiQueue.then(async () => {
    for (let k = 0; k < 6; k++) {
      const gap = Date.now() - lastAiAt; if (gap < 3000) await sleep(3000 - gap);
      lastAiAt = Date.now();
      try { return await aiChatOnce(prompt, timeoutMs); }
      catch (e) { if (/404/.test(e.message) && aiModel !== AI_MODELS[1]) { aiModel = AI_MODELS[1]; continue; } if (!/40[29]|429|5\d\d/.test(e.message) || k === 5) throw e; dbg("AI 限流，稍后重试：" + e.message); await sleep(5000 * (k + 1)); }
    }
  });
  aiQueue = run.catch(() => {});
  return run;
}
let aiModel = "openai";
async function aiChatOnce(prompt, timeoutMs = 90000) {
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(AI_URL, { method: "POST", headers: { "Content-Type": "application/json" }, signal: ctl.signal,
      body: JSON.stringify({ model: aiModel, messages: [{ role: "user", content: prompt }] }) });
    if (!r.ok) throw new Error("AI HTTP " + r.status);
    const d = await r.json();
    return (((d.choices || [])[0] || {}).message || {}).content || "";
  } finally { clearTimeout(tm); }
}
function parseJsonObj(s) { const i = s.indexOf("{"), j = s.lastIndexOf("}"); if (i < 0 || j < i) throw new Error("AI 没返回 JSON"); return JSON.parse(s.slice(i, j + 1)); }
const AI_MODELS = ["openai", "openai-fast"];   // only gpt-oss-20b is free/anonymous on Pollinations right now
let lastAiContext = { summary: "", glossary: [] };
async function aiTranslateAll(texts, title) {
  const out = new Array(texts.length).fill("");
  const numbered = texts.map((t, k) => `${k + 1}. ${t}`);
  const whole = numbered.join("\n");
  const big = whole.length > 6000;
  const transcriptForCtx = big ? numbered.slice(0, 120).join("\n") : whole;
  // Pass 1: scene summary + glossary of ambiguous words (cheap; failure is fine)
  let summary = "", glossary = [];
  try {
    const o = parseJsonObj(await aiChat(`下面是${srcName()}视频「${title || ""}」的语音转写（可能有识别错误）。请先理解场景。只输出 JSON：{"summary":"用一两句简体中文概括场景、说话人和语气","glossary":[{"src":"${srcName()}词","zh":"本语境下的中文意思","why":"为什么不是其他意思（简短）"}]}。glossary 只列多义词、俚语、地名人名和关键词，最多 15 个。\n${transcriptForCtx}`));
    summary = String(o.summary || ""); glossary = Array.isArray(o.glossary) ? o.glossary.slice(0, 15) : [];
    dbg("AI 场景：" + summary.slice(0, 60));
  } catch (e) { dbg("AI 第1步（场景）失败：" + e.message); }
  const glossTxt = glossary.map((g) => `${g.src || g.it || g.en || g.ja || ""} = ${g.zh}`).join("；");
  // Pass 2: translate with summary + glossary + full transcript (or sliding window)
  const B = big ? 40 : texts.length;
  for (let i = 0; i < texts.length; i += B) {
    const ctx = big ? numbered.slice(Math.max(0, i - 10), Math.min(texts.length, i + B + 10)).join("\n") : whole;
    const want = `${i + 1}–${Math.min(texts.length, i + B)}`;
    try {
      const obj = parseJsonObj(await aiChat(`你是专业的${srcName()}→中文字幕译者。\n场景：${summary || "（未知）"}\n本片词义表（必须遵守）：${glossTxt || "（无）"}\n请结合整段语境，把第 ${want} 行译成自然、口语化的简体中文字幕：保留语气词（${langCfg().fillers}），多义词按语境选义，不要逐词直译，识别错误按语境合理理解。只输出 JSON 对象，键为行号字符串，值为译文。\n转写：\n${ctx}`));
      for (let k = i; k < Math.min(texts.length, i + B); k++) { const z = obj[String(k + 1)]; if (okZh(z)) out[k] = toSimp(String(z).trim()); }
    } catch (e) { dbg("AI 第2步（翻译）失败：" + e.message); }
  }
  // Pass 3: self-check, corrections only
  if (out.some(Boolean)) {
    try {
      const pairs = texts.map((t, k) => `${k + 1}. ${t}\n   → ${out[k] || "（空）"}`).join("\n");
      const fix = parseJsonObj(await aiChat(`请审校下面的${srcName()}→中文字幕。场景：${summary}\n词义表：${glossTxt}\n只找出误译、漏译、语气不自然或与语境不符的行，给出修正后的译文。只输出 JSON，键为行号，值为修正译文；没有问题就输出 {}。\n${big ? pairs.slice(0, 9000) : pairs}`));
      let n = 0;
      for (const [k, v] of Object.entries(fix)) { const idx = Number(k) - 1; if (idx >= 0 && idx < out.length && okZh(v)) { out[idx] = toSimp(String(v).trim()); n++; } }
      dbg(`AI 第3步（审校）修正 ${n} 行`);
    } catch (e) { dbg("AI 第3步（审校）失败，保留第2步结果：" + e.message); }
  }
  lastAiContext = { summary, glossary };
  return out;
}
async function aiExplain(text, around) {
  return aiChat(`请用简体中文为中文母语的${srcName()}初学者解释这句${srcName()}。上下文：${around}\n句子：${text}\n按以下格式简洁回答：\n【意思】自然的中文意思\n【重点词】每个关键词：原形 + 词性 + 在本句的意思${curLang === "ja" ? " + 读音（假名）" : ""}\n【语法】1–3 个要点`);
}
async function googleOne(text, sl, tl) {
  const r = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=` + encodeURIComponent(text));
  if (!r.ok) throw new Error("Google " + r.status);
  return ((await r.json())[0] || []).map((x) => x[0] || "").join("").trim();
}
async function myMemoryPair(text, pair) {
  const d = await (await fetch("https://api.mymemory.translated.net/get?" + new URLSearchParams({ q: text, langpair: pair }))).json();
  const z = ((d.responseData || {}).translatedText || "").trim(); return z.includes("MYMEMORY WARNING") ? "" : z;
}
async function lingva(text) {
  const sl = srcCode();
  for (const h of ["lingva.ml", "lingva.lunar.icu", "translate.plausibility.cloud"]) {
    try { const r = await fetch(`https://${h}/api/v1/${sl}/zh/` + encodeURIComponent(text)); if (r.ok) { const z = (await r.json()).translation; if (z) return z; } } catch (e) {}
  }
  throw new Error("Lingva 实例都不可用");
}
async function alternatives(text, around) {
  const sl = srcCode(), name = srcName();
  const engines = [
    ["AI（结合上下文）", async () => { const o = parseJsonObj(await aiChat(`结合上下文把${name}句子译成自然口语化简体中文，给出 2 种不同译法。只输出 JSON {"1":"...","2":"..."}。上下文：${around}\n句子：${text}`)); return [o["1"], o["2"]].filter(Boolean).join(" ／ "); }],
    [`Google（${name}→中）`, () => googleOne(text, sl, "zh-CN")],
  ];
  if (sl !== "en") engines.push([`Google（${name}→英→中）`, async () => googleOne(await googleOne(text, sl, "en"), "en", "zh-CN")]);
  engines.push([`MyMemory（${name}→中）`, () => myMemoryPair(text, sl + "|zh-CN")]);
  if (sl !== "en") engines.push([`MyMemory（${name}→英→中）`, async () => myMemoryPair(await myMemoryPair(text, sl + "|en"), "en|zh-CN")]);
  engines.push(["Lingva", () => lingva(text)]);
  return Promise.all(engines.map(async ([n, fn]) => { try { const z = await fn(); return { name: n, zh: okZh(z) ? toSimp(z) : "", err: okZh(z) ? "" : "无结果" }; } catch (e) { return { name: n, zh: "", err: e.message }; } }));
}

/* ---- word lookup (Wiktionary + English dictionary API; Jisho lacks CORS so JA uses Wiktionary + readings) ---- */
const stripHtml = (s) => String(s || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
async function wiktLang(word, code) {
  const r = await fetch("https://en.wiktionary.org/api/rest_v1/page/definition/" + encodeURIComponent(word));
  if (!r.ok) return null;
  const d = await r.json();
  return d[code] || null;
}
function normalizeLookupWord(raw, lang = curLang) {
  const s = String(raw || "").trim();
  if (lang === "ja") return s.replace(/\s+/g, "");
  if (lang === "en") return s.toLowerCase().replace(/^[^a-zA-Z']+|[^a-zA-Z']+$/g, "");
  return s.toLowerCase().replace(/^[^a-zàèéìíòóù]*(?:[a-z]+['’])?/i, (m) => (/['’]$/.test(m) ? "" : m)).replace(/[^a-zàèéìíòóù]/gi, "");
}
async function wiktFollowLemma(word, code) {
  let lemma = word, entries = await wiktLang(word, code);
  if (entries) {
    const html = JSON.stringify(entries);
    const m = html.match(/form-of-definition-link[^]*?<a[^>]*title=\\"([^"\\]+)\\"/);
    const senses = entries.flatMap((e) => (e.definitions || []).map((x) => stripHtml(x.definition))).filter(Boolean);
    if (m && senses.every((s) => /\b(of|form)\b/.test(s) && s.length < 60)) { lemma = m[1]; entries = (await wiktLang(lemma, code)) || entries; }
  }
  return { lemma, entries };
}
async function jaReading(word) {
  try {
    const url = "https://en.wiktionary.org/w/api.php?" + new URLSearchParams({ action: "query", prop: "revisions", rvprop: "content", rvslots: "main", titles: word, format: "json", origin: "*" });
    const j = await (await fetch(url)).json();
    const pages = (j.query || {}).pages || {};
    const content = (Object.values(pages)[0] || {}).revisions?.[0]?.slots?.main?.["*"] || "";
    const m = content.match(/\{\{ja-pron\|([^}|]+)/) || content.match(/\{\{ja-verb\|([^}|]+)/) || content.match(/\{\{ja-noun\|[^|]*\|([^}|]+)/);
    if (m) return m[1].replace(/[-.]/g, "");
  } catch (e) {}
  return "";
}
async function lookupJisho(word) {
  // Jisho has no Access-Control-Allow-Origin; this succeeds only if that changes.
  const r = await fetch("https://jisho.org/api/v1/search/words?keyword=" + encodeURIComponent(word));
  if (!r.ok) return null;
  const d = await r.json();
  const hit = (d.data || [])[0];
  if (!hit) return null;
  const reading = ((hit.japanese || [])[0] || {}).reading || "";
  const lemma = ((hit.japanese || [])[0] || {}).word || word;
  const senses = (hit.senses || []).slice(0, 5).map((s) => {
    const en = (s.english_definitions || []).join("; ");
    return { pos: (s.parts_of_speech || []).join(", "), en };
  }).filter((s) => s.en);
  return { lemma, reading, senses };
}
async function lookupFreeDictEn(word) {
  const r = await fetch("https://api.dictionaryapi.dev/api/v2/entries/en/" + encodeURIComponent(word));
  if (!r.ok) return null;
  const d = await r.json();
  const entry = Array.isArray(d) ? d[0] : null;
  if (!entry) return null;
  const senses = [];
  (entry.meanings || []).forEach((m) => (m.definitions || []).forEach((x) => {
    if (x.definition) senses.push({ pos: m.partOfSpeech || "", en: x.definition });
  }));
  const phon = (entry.phonetic || ((entry.phonetics || [])[0] || {}).text || "").trim();
  return { lemma: entry.word || word, reading: phon, senses: senses.slice(0, 5) };
}
async function lookupWord(raw) {
  const lang = curLang;
  const w = normalizeLookupWord(raw, lang);
  if (!w) return { word: raw, lemma: raw, reading: "", senses: [], google: "" };
  let lemma = w, reading = "", entries = null, sensesIn = [];
  if (lang === "en") {
    const fd = await lookupFreeDictEn(w).catch(() => null);
    if (fd && fd.senses.length) { lemma = fd.lemma || w; reading = fd.reading || ""; sensesIn = fd.senses; }
    if (!sensesIn.length) {
      const wk = await wiktFollowLemma(w, "en");
      lemma = wk.lemma; entries = wk.entries;
    }
  } else if (lang === "ja") {
    const js = await lookupJisho(w).catch(() => null);
    if (js && js.senses.length) { lemma = js.lemma || w; reading = js.reading || ""; sensesIn = js.senses; }
    if (!sensesIn.length) {
      const wk = await wiktFollowLemma(w, "ja");
      lemma = wk.lemma; entries = wk.entries;
    }
    if (!reading) reading = await jaReading(lemma || w);
  } else {
    const wk = await wiktFollowLemma(w, "it");
    lemma = wk.lemma; entries = wk.entries;
  }
  const senses = sensesIn.slice();
  (entries || []).forEach((e) => (e.definitions || []).forEach((x) => { const t = stripHtml(x.definition); if (t) senses.push({ pos: e.partOfSpeech, en: t }); }));
  const top = senses.slice(0, 5);
  const zhs = await Promise.all(top.map((s) => myMemoryPair(s.en.split(/[;(]/)[0].slice(0, 120), "en|zh-CN").then(toSimp).catch(() => "")));
  top.forEach((s, i) => (s.zh = okZh(zhs[i]) ? zhs[i] : ""));
  let google = "";
  try {
    const r = await fetch("https://translate.googleapis.com/translate_a/single?client=gtx&sl=" + srcCode() + "&tl=zh-CN&dt=t&dt=bd&q=" + encodeURIComponent(lemma));
    if (r.ok) { const d = await r.json(); google = (d[1] || []).map((p) => p[0] + "：" + (p[1] || []).slice(0, 6).join("、")).join("；") || ((d[0] || [])[0] || [])[0] || ""; }
  } catch (e) {}
  return { word: w, lemma, reading, senses: top, google: toSimp(google) };
}
const getVocab = () => { try { return JSON.parse(localStorage.getItem(lsKey("vocab")) || "[]"); } catch (e) { return []; } };
const setVocab = (v) => { try { localStorage.setItem(lsKey("vocab"), JSON.stringify(v)); } catch (e) {} };

function modal(html) {
  let m = $("modal");
  if (!m) {
    m = document.createElement("div"); m.id = "modal";
    m.innerHTML = '<div class="mbg"></div><div class="mbox"><button type="button" class="mclose">关闭</button><div class="mbody"></div></div>';
    document.body.appendChild(m);
    m.querySelector(".mbg").onclick = m.querySelector(".mclose").onclick = () => (m.hidden = true);
  }
  m.querySelector(".mbody").innerHTML = html; m.hidden = false; return m.querySelector(".mbody");
}
const esc = (s) => String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function rubyTitle(word, reading) {
  if (reading && reading !== word) return `<ruby>${esc(word)}<rt>${esc(reading)}</rt></ruby>`;
  return esc(word);
}
async function showWord(word, sentence, lessonId) {
  const body = modal(`<h3>${esc(word)}</h3><p class="muted">查询中…</p>`);
  const r = await lookupWord(word);
  body.innerHTML = `<h3>${rubyTitle(r.word, r.reading)}${r.lemma !== r.word ? ` <span class="muted">← 原形 ${esc(r.lemma)}</span>` : ""}</h3>
    ${r.google ? `<p><b>词典：</b>${esc(r.google)}</p>` : ""}
    ${r.senses.length ? "<ol>" + r.senses.map((s) => `<li>${s.zh ? `<b>${esc(s.zh)}</b> · ` : ""}<span class="muted">${esc(s.pos)} · ${esc(s.en)}</span></li>`).join("") + "</ol>" : '<p class="muted">词典里没查到。</p>'}
    <p class="muted">例句：${esc(sentence)}</p><button type="button" class="primary" id="addVocab">加入生词本</button>`;
  body.querySelector("#addVocab").onclick = () => {
    const v = getVocab().filter((x) => x.lemma !== r.lemma);
    v.unshift({ word: r.word, lemma: r.lemma, reading: r.reading || "", zh: r.senses.map((s) => s.zh).filter(Boolean).slice(0, 3).join("；") || r.google, sentence, lessonId, lang: curLang, t: Date.now() });
    setVocab(v); body.querySelector("#addVocab").textContent = "已加入 ✓";
  };
}
function showVocab() {
  const v = getVocab();
  const empty = `<p class="muted">还没有生词。在课程里点${srcName()}单词即可查询并加入。</p>`;
  const body = modal(`<h3>${srcName()}生词本（${v.length}）</h3>` + (v.length ? v.map((x, i) => `<div class="vrow"><b>${x.reading ? `<ruby>${esc(x.lemma)}<rt>${esc(x.reading)}</rt></ruby>` : esc(x.lemma)}</b>${x.word !== x.lemma ? ` (${esc(x.word)})` : ""} — ${esc(x.zh)}<div class="muted">${esc(x.sentence)}</div><button type="button" data-i="${i}">删除</button></div>`).join("") : empty));
  body.querySelectorAll("button[data-i]").forEach((b) => (b.onclick = () => { const a2 = getVocab(); a2.splice(Number(b.dataset.i), 1); setVocab(a2); showVocab(); }));
}

/* Batches of ~8 neighbouring sentences go to Google in one request (context + fewer calls);
   anything empty/English is retried per line, then via MyMemory. Output forced to Simplified. */
async function translateSentences(texts, onEach, title) {
  if (onEach) onEach(0, texts.length);
  try { setWork("AI 正在理解语境并翻译…", "三步：概括场景 → 全文翻译 → 自我审校（约 20–90 秒）", null); } catch (e) {}
  const out = await aiTranslateAll(texts, title).catch(() => new Array(texts.length).fill(""));
  const ai = out.filter(Boolean).length;
  dbg(`AI 翻译 ${ai}/${texts.length}`);
  let google = 0, mm = 0;
  const B = 8;
  for (let i = 0; i < texts.length; i += B) {
    if (texts.slice(i, i + B).every((_, k) => out[i + k])) continue;
    if (cancelled) throw new Error("已取消");
    const batch = texts.slice(i, i + B);
    try {
      const res = await googleBatch(batch);
      res.forEach((z, k) => { if (!out[i + k] && okZh(z)) { out[i + k] = toSimp(z); google++; } });
    } catch (e) { dbg("Google 批量翻译失败：" + e.message); }
    for (let k = 0; k < batch.length; k++) {
      if (out[i + k]) continue;
      try { const z = await myMemory(batch[k]); if (okZh(z)) { out[i + k] = toSimp(z); mm++; } } catch (e) {}
      await sleep(120);
    }
    if (onEach) onEach(Math.min(texts.length, i + B), texts.length);
    await sleep(300);
  }
  const ok = out.filter(Boolean).length;
  const method = ok ? `AI(Pollinations) ${ai} + Google ${google} + MyMemory ${mm}（已转简体）` : "none (translation failed)";
  return { zh: out, method, ok, summary: lastAiContext.summary, glossary: lastAiContext.glossary };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ---------------- worker ---------------- */
function ensureWorker() {
  if (worker) return worker;
  dbg("创建识别 worker…");
  worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  dbg("worker 对象已创建");
  worker.addEventListener("message", (ev) => { if (ev.data && ev.data.type === "log") dbg("worker: " + ev.data.message); });
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
      w.removeEventListener("message", handle);
      if (msg.type === "error") reject(new Error(msg.message || "识别失败"));
      else resolve(msg);
    };
    w.addEventListener("message", handle);
    w.onerror = (e) => { w.removeEventListener("message", handle); reject(new Error("识别线程崩溃：" + (e.message || ""))); };
  });
}

async function loadModel(modelId, onProgress) {
  const w = ensureWorker();
  const p = waitWorker(onProgress);
  w.postMessage({ type: "load", modelId, preferGpu: !IS_IOS, language: langCfg().whisper });
  return p;
}

async function transcribeChunk(pcmChunk, offset) {
  const w = ensureWorker();
  const p = waitWorker();
  w.postMessage({ type: "chunk", audio: pcmChunk, offset, language: langCfg().whisper }, [pcmChunk.buffer]);
  return p;
}

/* ---- resumable job (IndexedDB "lessons" store, id "__job__") ---- */
const JOB_ID = "__job__";
async function saveJob(job) { try { await putLesson({ ...job, id: JOB_ID }); } catch (e) { dbg("保存进度失败：" + e.message); } }
async function clearJob() { try { await delLesson(JOB_ID); } catch (e) {} }

async function processFile(file) {
  cancelled = false;
  showView("work");
  $("workLog").textContent = "";
  dbg("选择文件：" + (file.name || "") + " " + fmtBytes(file.size) + (IS_IOS ? " (iOS)" : ""));
  setWork("正在提取音频…", file.name || "", 5);
  let decoded;
  try {
    decoded = await decodeTo16kMono(file, (f) => setWork("正在提取音频…", "通过播放视频提取声音（需要与视频等长的时间）", 5 + f * 15));
  } catch (e) {
    dbg("提取失败：" + ((e && e.message) || e));
    setWork("无法提取音频", "请改用 MP3/M4A 音频，或在相册里把视频导出为较小的文件再试。\n" + ((e && e.message) || e), 0);
    return;
  }
  let videoBlob = null;
  if ((file.type || "").startsWith("video/") || /\.(mp4|mov|m4v|webm)$/i.test(file.name || "")) {
    if (file.size > 300 * 1048576) workLog("视频超过 300 MB，只保存音频（避免占满手机存储）。");
    else { videoBlob = file; if (file.size > 80 * 1048576) workLog("提示：视频较大（" + fmtBytes(file.size) + "），会占用较多手机存储。"); }
  }
  file = null;
  const pcm = decoded.pcm;
  if (decoded.duration > 10 * 60) workLog("提示：超过 10 分钟，手机上会很慢、可能被系统关闭页面。建议先剪短。");
  workLog(`音频 ${fmtDur(decoded.duration)}`);
  dbg("音频长度 " + decoded.duration.toFixed(1) + "s，压缩保存中");
  const audioBlob = encodeMp3(pcm) || encodeWav(pcm);
  const job = {
    title: (decodedTitle || (srcName() + "跟读")), createdAt: Date.now(), duration: decoded.duration,
    audio: audioBlob, audioMime: audioBlob.type, video: videoBlob, model: modelSel.value, lang: curLang, segments: [], doneSec: 0,
  };
  await saveJob(job);
  dbg("已保存可续做的进度（释放音频内存后再加载模型）");
  await runJob(job);
}
let decodedTitle = "";

async function resumeJob() {
  const job = await getLesson(JOB_ID);
  if (!job) return;
  showView("work");
  dbg(`继续上次：已完成 ${Math.round(job.doneSec)}s / ${Math.round(job.duration)}s`);
  await runJob(job);
}

async function runJob(job) {
  let modelId = job.model || langCfg().tiny;
  const prevCrash = localStorage.getItem(loadingKey());
  if (prevCrash && prevCrash !== TINY) { const fb = fallbackOf(prevCrash); dbg(`上次用 ${prevCrash} 时页面刷新，改用 ${fb}`); modelId = fb; }
  job.model = modelId; await saveJob(job);
  try { localStorage.setItem(loadingKey(), modelId); } catch (e) {}
  const meta = MODELS[modelId] || { label: modelId, downloadMB: "?" };
  setWork("正在加载语音识别模型…", `首次需要下载约 ${meta.downloadMB} MB`, 20);
  dbg("加载模型 " + modelId);
  const lastPct = {};
  let ready;
  try {
    ready = await loadModel(modelId, (msg) => {
      if (msg.phase === "download" && msg.status === "done" && msg.file) dbg("模型文件就绪：" + msg.file);
      if (msg.phase === "download" && msg.total && msg.pct != null && msg.pct % 25 === 0 && lastPct[msg.file] !== msg.pct) { lastPct[msg.file] = msg.pct; dbg(`下载 ${msg.file} ${msg.pct}%`); }
      if (msg.phase === "download" && msg.total) {
        setWork("正在加载语音识别模型…", `下载 ${(msg.file || "").split("/").pop()} ${fmtBytes(msg.loaded)} / ${fmtBytes(msg.total)}`, 20 + (msg.pct || 0) * 0.2);
      }
    });
    dbg(`模型就绪 ${ready.device}/${ready.dtype}`);
  } catch (e) {
    dbg("模型加载失败：" + e.message);
    setWork("模型加载失败", e.message, 0);
    return;
  }
  let pcm;
  try {
    // Prefer the original video so timestamps line up with playback (avoid MP3 encoder delay).
    const src = job.video || job.audio;
    const name = job.video ? "job.mp4" : "job.mp3";
    const typ = job.video ? (job.video.type || "video/mp4") : (job.audioMime || "audio/mpeg");
    pcm = (await decodeTo16kMono(new File([src], name, { type: typ }))).pcm;
  } catch (e) { dbg("重新解码失败：" + e.message); setWork("无法读取音频", String(e.message || e), 0); return; }
  const CH = 30 * RATE, OV = 5 * RATE;
  let timeShift = 0;
  if (!job.doneSec) {
    const win = Math.round(0.03 * RATE), thr = 0.015;
    let onset = 0;
    for (let i = 0; i + win < pcm.length; i += win) {
      let e = 0;
      for (let j = 0; j < win; j++) e += pcm[i + j] * pcm[i + j];
      if (Math.sqrt(e / win) > thr) { onset = i / RATE; break; }
    }
    const cut = Math.round(Math.max(0, onset - 0.2) * RATE);
    if (cut > 0.25 * RATE) {
      pcm = pcm.subarray(cut);
      timeShift = cut / RATE;
      dbg("去掉片头静音 " + timeShift.toFixed(2) + "s（保留 0.2s）");
    }
  }
  const total = pcm.length;
  const t0 = performance.now();
  for (let start = Math.round(job.doneSec * RATE); start < total; start += CH) {
    if (cancelled) return;
    const end = Math.min(total, start + CH);
    const from = Math.max(0, start - (start > 0 ? OV : 0));
    setWork(`正在识别${srcName()}…`, `已处理 ${fmtDur(start / RATE)} / ${fmtDur(total / RATE)}`, 40 + (start / total) * 38);
    dbg(`识别 ${Math.round(from / RATE)}–${Math.round(end / RATE)}s`);
    let res;
    try { res = await transcribeChunk(pcm.slice(from, end), from / RATE); }
    catch (e) { dbg("识别失败：" + e.message); setWork("识别失败", e.message + "（可返回后点「继续上次」）", 0); return; }
    const segs = (res.segments || []).filter((s) => {
      const mid = (Number(s.start) + Number(s.end)) / 2;
      return mid >= start / RATE - 1e-3 && mid < end / RATE + 1e-3;
    });
    if (segs[0]) dbg("片段 " + segs.length + " 个，首 " + segs[0].start.toFixed(2) + "–" + segs[0].end.toFixed(2) + " " + (segs[0].text || "").slice(0, 40));
    if (timeShift) {
      // After trimming lead-in, Whisper often still stamps the first word at 0; snap it to the real onset.
      if (start === 0 && segs[0] && segs[0].start < 0.35) {
        const snap = Math.max(0, 0.2 - segs[0].start);
        if (snap) segs.forEach((s) => { s.start += snap; s.end += snap; });
      }
      segs.forEach((s) => { s.start += timeShift; s.end += timeShift; });
    }
    job.segments.push(...segs);
    job.doneSec = end / RATE;
    await saveJob(job);
  }
  const transcribeMs = performance.now() - t0;
  try { localStorage.removeItem(loadingKey()); } catch (e) {}
  dbg(`识别完成 ${job.segments.length} 段`);
  const sentences = toSentenceSegments(job.segments);
  setWork("正在翻译成中文…", `0 / ${sentences.length}`, 80);
  let tr = { zh: sentences.map(() => ""), method: "none", ok: 0 };
  try {
    tr = await translateSentences(sentences.map((s) => s.text), (i, n) => setWork("正在翻译成中文…", `${i} / ${n}`, 80 + (i / n) * 17), job.title);
  } catch (e) { dbg("翻译失败：" + e.message); }
  dbg(`翻译 ${tr.ok}/${sentences.length}`);
  const lesson = {
    id: "L" + Date.now().toString(36), title: job.title, createdAt: job.createdAt, duration: job.duration,
    model: modelId, device: ready.device, dtype: ready.dtype, lang: job.lang || curLang, translationMethod: tr.method, summary: tr.summary || "", glossary: tr.glossary || [], transcribeMs,
    audioMime: job.audioMime, audio: job.audio, video: job.video || null,
    sentences: sentences.map((s, i) => ({ i, start: Math.round(s.start * 1000) / 1000, end: Math.round(s.end * 1000) / 1000, it: s.text, zh: tr.zh[i] || "" })),
  };
  await putLesson(lesson);
  await clearJob();
  dbg("课程已保存，完成");
  await openLesson(lesson.id, lesson);
}


/* ---------------- SRT mode (no ASR) ---------------- */
function parseSrt(text) {
  const out = [];
  const re = /(\d{1,2}:)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,2}:)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;
  const ts = (h, m, s, ms) => (h ? parseInt(h) * 3600 : 0) + parseInt(m) * 60 + parseInt(s) + parseInt(ms.padEnd(3, "0").slice(0, 3)) / 1000;
  const lines = text.replace(/\r/g, "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    const body = [];
    while (i + 1 < lines.length && lines[i + 1].trim() && !re.test(lines[i + 1])) body.push(lines[++i]);
    const t = body.join(" ").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (t) out.push({ start: ts(m[1], m[2], m[3], m[4]), end: ts(m[5], m[6], m[7], m[8]), text: t });
  }
  return out;
}
async function processWithSrt(media, srtText) {
  cancelled = false;
  showView("work");
  dbg("字幕模式：" + media.name + " + 字幕");
  const segs = parseSrt(srtText);
  if (!segs.length) { setWork("字幕文件里没有可用的时间轴", "请选择 .srt 或 .vtt 文件", 0); return; }
  setWork("正在提取音频…", media.name, 10);
  let pcm, duration;
  try { const d = await decodeTo16kMono(media); pcm = d.pcm; duration = d.duration; }
  catch (e) { setWork("无法提取音频", String(e.message || e), 0); return; }
  const audio = encodeMp3(pcm) || encodeWav(pcm); pcm = null;
  let videoBlob = null;
  if ((media.type || "").startsWith("video/") || /\.(mp4|mov|m4v|webm)$/i.test(media.name || "")) {
    if (media.size <= 300 * 1048576) videoBlob = media;
  }
  const sentences = toSentenceSegments(segs);
  let tr = { zh: sentences.map(() => ""), method: "none", ok: 0 };
  try { tr = await translateSentences(sentences.map((s) => s.text), (i, n) => setWork("正在翻译成中文…", `${i} / ${n}`, 30 + (i / n) * 65), media.name); } catch (e) {}
  const lesson = {
    id: "L" + Date.now().toString(36), title: media.name.replace(/\.[^.]+$/, ""), createdAt: Date.now(), duration,
    model: "srt", device: "-", dtype: "-", lang: curLang, translationMethod: tr.method, summary: tr.summary || "", glossary: tr.glossary || [], audioMime: audio.type, audio, video: videoBlob,
    sentences: sentences.map((s, i) => ({ i, start: Math.round(s.start * 1000) / 1000, end: Math.round(s.end * 1000) / 1000, it: s.text, zh: tr.zh[i] || "" })),
  };
  await putLesson(lesson);
  dbg("字幕模式完成 " + sentences.length + " 句");
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
  const media = lesson.video || lesson.audio;
  currentAudioUrl = media ? URL.createObjectURL(media) : "";
  $("vbox").hidden = !lesson.video;
  $("vid").onloadedmetadata = () => window.dispatchEvent(new Event("resize"));
  $("btnSubMode").hidden = !lesson.video;
  $("orig").removeAttribute("src"); $("vid").removeAttribute("src");
  (lesson.video ? $("vid") : $("orig")).src = currentAudioUrl || "";
  $("playerTitle").textContent = lesson.title || (srcName() + "跟读");
  $("playerMeta").textContent = [
    (lesson.sentences || []).length + " 句",
    fmtDur(lesson.duration),
    srcName() + " → 简体中文",
  ].filter(Boolean).join(" · ");
  const sb = $("sceneBox");
  const gl = (lesson.glossary || []).map((g) => `${esc(g.src || g.it || g.en || g.ja || "")}＝${esc(g.zh)}`).join("　");
  sb.innerHTML = lesson.summary ? `<b>场景：</b>${esc(lesson.summary)}${gl ? `<div class="muted" style="margin-top:4px">词义：${gl}</div>` : ""}` : "";
  sb.hidden = !lesson.summary;
  showView("player");
  if (playerCtl && playerCtl.destroy) playerCtl.destroy();
  playerCtl = attachPlayer(lesson, currentAudioUrl);
}

function attachPlayer(lesson, audioSrc) {
  const sentences = lesson.sentences || [];
  const storageKey = "miraa-" + (lesson.lang || curLang) + ":" + (lesson.id || "lesson");
  const listEl = $("list");
  const orig = lesson.video ? $("vid") : $("orig");
  const subIt = document.querySelector("#sub .sit"), subZh = document.querySelector("#sub .szh");
  const SUBMODES = ["双语", srcName(), "中文", "关闭"];
  let subMode = 0;
  try { subMode = Number(localStorage.getItem(lsKey("submode")) || 0) % 4; } catch (e) {}
  const btnSubMode = $("btnSubMode");
  btnSubMode.textContent = "字幕：" + SUBMODES[subMode];
  function adjT() { return (orig.currentTime || 0) - subOffset; }
  function showSub(t) {
    if (!lesson.video) return;
    const s = sentences.find((x) => t >= x.start - 0.02 && t < x.end + 0.05) || null;
    subIt.textContent = s && (subMode === 0 || subMode === 1) ? s.it : "";
    subZh.textContent = s && (subMode === 0 || subMode === 2) ? s.zh : "";
  }
  function sentenceAt(t) {
    if (!sentences.length) return -1;
    let last = -1;
    for (let i = 0; i < sentences.length; i++) {
      const s = sentences[i];
      if (t >= s.start - 0.02) last = i;
      if (t <= s.end + 0.05) return t >= s.start - 0.05 ? i : (last >= 0 ? last : i);
    }
    return last;
  }
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
  let pauseEach = false;
  let subOffset = Number(lesson.subOffset);
  if (!Number.isFinite(subOffset)) subOffset = Number(state.subOffset);
  if (!Number.isFinite(subOffset)) subOffset = 0;
  subOffset = Math.round(Math.max(-5, Math.min(5, subOffset)) * 10) / 10;
  let raf = 0;
  let loopGuard = 0;
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
    document.documentElement.style.scrollPaddingTop = ($("playerHead").offsetHeight + 8) + "px";
    document.documentElement.style.scrollPaddingBottom = ($("bar").offsetHeight + 8) + "px";
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
        '<div class="rec-row"><button type="button" class="explain">解释这句</button><button type="button" class="alt">换个翻译</button><button type="button" class="editzh">改中文</button><button type="button" class="edit">编辑原文</button><button type="button" class="play-mine">播放我的录音</button>' +
        '<button type="button" class="cmp">对比：先原音再我的</button></div>';
      el.querySelector(".idx").textContent = (i + 1) + " / " + sentences.length + " · " + fmt(s.start);
      el.querySelector(".star").textContent = isFav(i) ? "★" : "☆";
      const itEl = el.querySelector(".it");
      tokenizeText(s.it || "", lesson.lang || curLang).forEach((tok) => {
        if (!tok.word) { itEl.appendChild(document.createTextNode(tok.t)); return; }
        const sp = document.createElement("span"); sp.className = "w"; sp.textContent = tok.t;
        sp.addEventListener("click", (e) => { if (i !== idx) return; e.stopPropagation(); showWord(tok.t, s.it, lesson.id); });
        itEl.appendChild(sp);
      });
      const around = () => sentences.slice(Math.max(0, i - 2), i + 3).map((x) => x.it).join(" ");
      el.querySelector(".explain").addEventListener("click", async (e) => {
        e.stopPropagation(); const body = modal(`<h3>解释</h3><p>${esc(s.it)}</p><p class="muted">AI 思考中…（约 5–20 秒）</p>`);
        try { body.innerHTML = `<h3>解释</h3><p><b>${esc(s.it)}</b></p><div style="white-space:pre-wrap">${esc(await aiExplain(s.it, around()))}</div>`; }
        catch (er) { body.innerHTML = `<p>AI 暂时不可用：${esc(er.message)}</p>`; }
      });
      el.querySelector(".alt").addEventListener("click", async (e) => {
        e.stopPropagation(); const body = modal(`<h3>换个翻译</h3><p>${esc(s.it)}</p><p class="muted">正在向多个引擎查询…</p>`);
        const alts = await alternatives(s.it, around());
        body.innerHTML = `<h3>换个翻译</h3><p><b>${esc(s.it)}</b></p><p class="muted">当前：${esc(s.zh)}</p>` + alts.map((x, k) => `<div class="vrow"><div class="muted">${esc(x.name)}</div>${x.zh ? `${esc(x.zh)} <button type="button" data-k="${k}">用这个</button>` : `<span class="muted">（${esc(x.err)}）</span>`}</div>`).join("");
        body.querySelectorAll("button[data-k]").forEach((b) => (b.onclick = async () => { s.zh = alts[Number(b.dataset.k)].zh; try { await putLesson(lesson); } catch (er) {} $("modal").hidden = true; renderList(); }));
      });
      el.querySelector(".editzh").addEventListener("click", async (e) => {
        e.stopPropagation(); const nz = prompt("修改中文译文：", s.zh || ""); if (nz == null) return;
        s.zh = nz.trim(); try { await putLesson(lesson); } catch (er) {} renderList();
      });
      el.querySelector(".zh").textContent = s.zh || "";
      if (!recUrls[i]) {
        el.querySelector(".play-mine").disabled = true;
        el.querySelector(".cmp").disabled = true;
      }
      el.addEventListener("click", () => select(i, { play: true, scroll: false }));
      el.querySelector(".star").addEventListener("click", (e) => toggleFav(i, e));
      el.querySelector(".play-mine").addEventListener("click", (e) => { e.stopPropagation(); playMine(i); });
      el.querySelector(".edit").addEventListener("click", async (e) => {
        e.stopPropagation();
        const nt = prompt("修改这句" + srcName() + "（保存后会重新翻译）：", s.it);
        if (nt == null || !nt.trim() || nt.trim() === s.it) return;
        s.it = nt.trim();
        s.zh = "翻译中…"; renderList();
        s.zh = await translateOne(s.it);
        try { await putLesson(lesson); } catch (er) {}
        renderList(); if (i === idx) nowIt.textContent = s.it;
      });
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
  function highlight(i, scroll) {
    if (i < 0 || i >= sentences.length) return;
    const changed = i !== idx;
    idx = i;
    if (changed) save();
    nowIt.textContent = sentences[i].it || "";
    document.querySelectorAll("#list .sentence").forEach((el) => {
      el.classList.toggle("current", Number(el.dataset.i) === i);
    });
    if (scroll && changed) {
      const el = currentEl();
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }
  function select(i, opts) {
    opts = opts || {};
    if (i < 0 || i >= sentences.length) return;
    highlight(i, !!opts.scroll);
    showSub(opts.play ? sentences[i].start + 0.01 : adjT());
    pbar.style.width = "0%";
    if (opts.play) playCurrent({ seek: true });
  }
  function startTick() {
    if (raf) return;
    const loop = () => { raf = requestAnimationFrame(loop); onTick(); };
    raf = requestAnimationFrame(loop);
  }
  function stopTick() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }
  function seekAndPlay(transcriptStart) {
    const target = Math.max(0, transcriptStart + subOffset);
    const go = () => orig.play().then(() => { playing = true; startTick(); syncPlayBtn(); }).catch(() => { playing = false; syncPlayBtn(); });
    if (orig.readyState < 1) {
      orig.addEventListener("loadedmetadata", () => { try { orig.currentTime = target; } catch (e) {} go(); }, { once: true });
      return;
    }
    if (Math.abs((orig.currentTime || 0) - target) < 0.07) { go(); return; }
    let done = false;
    const finish = () => { if (done) return; done = true; orig.removeEventListener("seeked", finish); go(); };
    orig.addEventListener("seeked", finish);
    try { orig.currentTime = target; } catch (e) { finish(); }
    setTimeout(finish, 350);
  }
  function playCurrent(opts) {
    const s = sentences[idx];
    if (!audioSrc || !s) return;
    comparing = false;
    mine.pause();
    orig.playbackRate = Number(speedEl.value) || 1;
    if (opts && opts.seek === false) {
      orig.play().then(() => { playing = true; startTick(); syncPlayBtn(); }).catch(() => { playing = false; syncPlayBtn(); });
    } else seekAndPlay(s.start);
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
  function setPauseEach(on) {
    pauseEach = !!on;
    const b = $("btnPauseEach");
    if (b) { b.classList.toggle("on", pauseEach); b.setAttribute("aria-pressed", pauseEach ? "true" : "false"); }
  }
  function renderOffset() {
    const el = $("offsetVal");
    if (el) el.textContent = "字幕 " + (subOffset >= 0 ? "+" : "") + subOffset.toFixed(1) + "s";
  }
  function changeOffset(d) {
    subOffset = Math.round((subOffset + d) * 10) / 10;
    if (subOffset > 5) subOffset = 5;
    if (subOffset < -5) subOffset = -5;
    lesson.subOffset = subOffset;
    state.subOffset = subOffset;
    save();
    putLesson(lesson).catch(() => {});
    renderOffset();
    showSub(adjT());
  }
  function setHideZh(on, persist) {
    document.body.classList.toggle("hide-zh", on);
    btnZh.setAttribute("aria-pressed", on ? "false" : "true");
    btnZh.textContent = on ? "显示译文" : "隐藏译文";
    if (persist !== false) { state.hideZh = on; save(); }
  }

  function onTick() {
    const t = adjT();
    showSub(t);
    const s = sentences[idx];
    if (s) {
      const start = s.start, end = Math.max(s.end, start + 0.2);
      pbar.style.width = Math.min(100, Math.max(0, ((t - start) / (end - start)) * 100)) + "%";
    }
    if (!playing) return;
    // Continuous mode: only retarget the highlight — never seek/pause at a sentence boundary.
    const i = sentenceAt(t);
    if (i >= 0 && i !== idx && !looping && !comparing) highlight(i, true);
    const cur = sentences[idx];
    if (!cur) return;
    const end = Math.max(cur.end, cur.start + 0.2);
    if (t < end - 0.02) return;
    if (looping && !comparing) {
      const now = performance.now();
      if (now - loopGuard < 200) return;
      loopGuard = now;
      seekAndPlay(cur.start);
    } else if (comparing && recUrls[idx]) {
      orig.pause();
      playing = false;
      syncPlayBtn();
      playMine(idx);
      comparing = false;
    } else if (pauseEach) {
      orig.pause();
      playing = false;
      pbar.style.width = "100%";
      syncPlayBtn();
    }
  }
  function onEnded() {
    if (looping) playCurrent({ seek: true });
    else { playing = false; syncPlayBtn(); }
  }
  renderOffset();
  on(orig, "timeupdate", onTick); // backup when rAF is throttled; no extra seeks in continuous mode
  on(btnSubMode, "click", () => { subMode = (subMode + 1) % 4; btnSubMode.textContent = "字幕：" + SUBMODES[subMode]; try { localStorage.setItem(lsKey("submode"), subMode); } catch (e) {} showSub(adjT()); });
  on(orig, "ended", onEnded);
  on(btnPlay, "click", () => {
    if (playing) { pauseAll(); return; }
    const s = sentences[idx];
    const t = adjT();
    if (s && t >= s.end - 0.08) {
      if (pauseEach && idx < sentences.length - 1) select(idx + 1, { play: true, scroll: true });
      else playCurrent({ seek: false });
      return;
    }
    // Resume in place (including lead-in before the first sentence). Seeking is only for list/next/prev/loop.
    playCurrent({ seek: false });
  });
  const btnPauseEach = $("btnPauseEach");
  if (btnPauseEach) on(btnPauseEach, "click", () => setPauseEach(!pauseEach));
  const btnOffMinus = $("btnOffMinus"), btnOffPlus = $("btnOffPlus");
  if (btnOffMinus) on(btnOffMinus, "click", () => changeOffset(-0.1));
  if (btnOffPlus) on(btnOffPlus, "click", () => changeOffset(0.1));
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
      stopTick();
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
    language: L.lang || curLang, language_name: srcName(),
    translation: "zh-CN",
    duration: L.duration,
    created_at: new Date(L.createdAt || Date.now()).toISOString(),
    whisper_model: L.model,
    translation_method: L.translationMethod,
    sentences: L.sentences,
    audio_src: audioSrc,
    audio_mime: L.audioMime || "",
  };
  let html = EXPORT_TEMPLATE.replace("__LESSON_JSON__", JSON.stringify(payload));
  if (L.video && L.video.size < 50 * 1048576) {
    payload.audio_src = "data:" + (L.video.type || "video/mp4") + ";base64," + (await blobToBase64(L.video));
    html = EXPORT_TEMPLATE.replace("__LESSON_JSON__", JSON.stringify(payload))
      .replace('<audio id="orig" playsinline></audio>', "")
      .replace("<main>", '<div style="position:sticky;top:0;z-index:25;background:#000"><video id="orig" playsinline style="display:block;width:100%;max-height:34vh"></video><div id="xsub" style="position:absolute;left:6px;right:6px;bottom:8px;text-align:center;pointer-events:none;color:#fff;text-shadow:0 0 4px #000,0 0 4px #000;font-weight:600"></div></div><main>')
      .replace("</script></body>", 'document.getElementById("orig").addEventListener("timeupdate",function(){var t=this.currentTime,s=(LESSON.sentences||[]).find(function(x){return t>=x.start&&t<x.end});document.getElementById("xsub").innerHTML=s?(s.it.replace(/</g,"&lt;")+"<br><span style=\'color:#ffe7a8;font-weight:400\'>"+(s.zh||"").replace(/</g,"&lt;")+"</span>"):""});\n</script></body>');
  } else if (L.video) {
    alert("视频大于 50 MB，导出文件只包含音频。");
  }
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
<meta name="theme-color" content="#1f3a2e"><title>外语跟读</title>
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
<header><div class="head-row"><div><h1 id="title">外语跟读</h1><div class="meta" id="meta"></div></div>
<div class="toggles"><button class="icon-btn" id="btnFavFilter" aria-pressed="false" title="只看收藏">★</button></div></div>
<div class="toolbar"><button type="button" id="btnZh" aria-pressed="true">隐藏译文</button><button type="button" id="btnLoop">循环本句</button><button type="button" id="btnPauseEach">逐句暂停</button></div></header>
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
  document.getElementById("title").textContent=LESSON.title||"外语跟读";
  document.title=(LESSON.title||"外语跟读")+" · 跟读";
  function fmt(t){t=Math.max(0,t||0);const m=Math.floor(t/60),s=Math.floor(t%60);return m+":"+String(s).padStart(2,"0")}
  document.getElementById("meta").textContent=[sentences.length+" 句", LESSON.duration?fmt(LESSON.duration):"",(LESSON.language_name||"外语")+" → 简体中文"].filter(Boolean).join(" · ");
  if(LESSON.audio_src) orig.src=LESSON.audio_src; else document.getElementById("noAudio").hidden=false;
  if(!(window.isSecureContext||location.protocol==="https:"||location.hostname==="localhost")) document.getElementById("secureNote").hidden=false;
  let state={last:0,favorites:[],hideZh:false};
  try{state=Object.assign(state,JSON.parse(localStorage.getItem(storageKey)||"{}"))}catch(e){}
  let idx=Math.min(Math.max(0,state.last|0),Math.max(0,sentences.length-1));
  let looping=false,pauseEach=false,playing=false,comparing=false,recorder=null,recStream=null,raf=0,loopGuard=0;
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
  function startTick(){if(raf)return;const loop=()=>{raf=requestAnimationFrame(loop);onTick()};raf=requestAnimationFrame(loop)}
  function playCurrent(opts){const s=sentences[idx];if(!LESSON.audio_src||!s)return;comparing=false;mine.pause();orig.playbackRate=Number(speedEl.value)||1;
    const start=Math.max(0,s.start); const go=()=>orig.play().then(()=>{playing=true;startTick();sync()}).catch(()=>{playing=false;sync()});
    if(opts&&opts.seek===false){go();return}
    const seek=()=>{if(Math.abs((orig.currentTime||0)-start)<0.07){go();return}try{orig.currentTime=start}catch(e){} orig.addEventListener("seeked",go,{once:true});setTimeout(go,350)};
    if(orig.readyState>=1)seek(); else orig.addEventListener("loadedmetadata",seek,{once:true});
  }
  function pauseAll(){playing=false;comparing=false;orig.pause();mine.pause();sync()}
  function sync(){btnPlay.textContent=playing?"⏸ 暂停":"▶ 播放"}
  function setLoop(on){looping=on;btnLoop.classList.toggle("on",on);btnLoop2.classList.toggle("on",on);btnLoop.textContent=on?"循环中":"循环本句"}
  function setPauseEach(on){pauseEach=!!on;const b=document.getElementById("btnPauseEach");if(b){b.classList.toggle("on",pauseEach);b.setAttribute("aria-pressed",pauseEach?"true":"false")}}
  function setHideZh(on,persist){document.body.classList.toggle("hide-zh",on);btnZh.setAttribute("aria-pressed",on?"false":"true");btnZh.textContent=on?"显示译文":"隐藏译文";if(persist!==false){state.hideZh=on;save()}}
  function onTick(){const s=sentences[idx];if(!s)return;const start=s.start,end=Math.max(s.end,start+0.2),t=orig.currentTime;
    pbar.style.width=Math.min(100,Math.max(0,((t-start)/(end-start))*100))+"%";
    if(!playing)return;
    if(!looping&&!comparing){for(let i=0;i<sentences.length;i++){if(t>=sentences[i].start-0.05&&t<Math.max(sentences[i].end,sentences[i].start+0.2)+0.05){if(i!==idx){idx=i;save();nowIt.textContent=sentences[i].it||"";document.querySelectorAll(".sentence").forEach(el=>el.classList.toggle("current",Number(el.dataset.i)===i));const el=currentEl();if(el)el.scrollIntoView({behavior:"smooth",block:"center"})}break;}}}
    if(t>=end-0.02){if(looping&&!comparing){const now=performance.now();if(now-loopGuard<200)return;loopGuard=now;try{orig.currentTime=start}catch(e){}orig.play().catch(()=>{})}
      else if(comparing&&recUrls[idx]){orig.pause();playing=false;sync();playMine(idx);comparing=false}
      else if(pauseEach){orig.pause();playing=false;pbar.style.width="100%";sync()}}
    const xs=document.getElementById("xsub"); if(xs){const hit=sentences.find(x=>t>=x.start&&t<x.end);xs.innerHTML=hit?(hit.it.replace(/</g,"&lt;")+"<br><span style='color:#ffe7a8;font-weight:400'>"+(hit.zh||"").replace(/</g,"&lt;")+"</span>"):""}
  }
  orig.addEventListener("timeupdate",onTick);
  orig.addEventListener("ended",()=>{if(looping)playCurrent({seek:true});else{playing=false;sync()}});
  btnPlay.addEventListener("click",()=>{if(playing){pauseAll();return}const s=sentences[idx],t=orig.currentTime;if(s&&t>=s.end-0.08){if(pauseEach&&idx<sentences.length-1)select(idx+1,{play:true,scroll:true});else playCurrent({seek:false});return}if(s&&t>=s.start-0.05&&t<s.end-0.08)playCurrent({seek:false});else playCurrent({seek:true})});
  const btnPauseEach=document.getElementById("btnPauseEach"); if(btnPauseEach) btnPauseEach.addEventListener("click",()=>setPauseEach(!pauseEach));
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

/* ---------------- language UI ---------------- */
function fillModelSelect() {
  const L = langCfg();
  const prev = modelSel.value;
  modelSel.innerHTML = "";
  L.models.forEach((id) => {
    const m = MODEL_CATALOG[id]; if (!m) return;
    const opt = document.createElement("option");
    opt.value = id;
    const kind = m.enOnly ? "英语专用，" : (L.id === "en" && !m.enOnly ? "多语，" : "");
    const rec = id === L.tiny ? "推荐，" : "";
    const speed = id.includes("small") ? "最准 · " : id.includes("base") ? "较准 · " : "快速 · ";
    opt.textContent = `${speed}${m.label}（约 ${m.downloadMB} MB，${kind}${rec}`.replace(/，$/, "") + "）";
    modelSel.appendChild(opt);
  });
  let saved = null;
  try { saved = localStorage.getItem(modelKey()); } catch (e) {}
  if (saved && L.models.includes(saved)) modelSel.value = saved;
  else if (L.models.includes(prev)) modelSel.value = prev;
  else modelSel.value = L.tiny;
}
function applyCrashNotes() {
  const crashed = localStorage.getItem(loadingKey());
  if ($("baseCrashNote")) $("baseCrashNote").hidden = true;
  if ($("tinyCrashNote")) $("tinyCrashNote").hidden = true;
  if (!crashed) return;
  const fb = fallbackOf(crashed);
  if (fb && fb !== crashed) {
    try { localStorage.setItem(modelKey(), fb); } catch (e) {}
    dbg(`检测到上次用 ${crashed} 时页面被重新加载（多半内存不足），已切换为 ${fb}`);
    if ($("baseCrashNote")) {
      $("baseCrashNote").textContent = `上次用「${(MODELS[crashed] || {}).label || crashed}」时页面被刷新了：这台手机在这个浏览器里内存不够。已自动换成「${(MODELS[fb] || {}).label || fb}」。如有未完成的课，可点下方「继续上次」接着做。`;
      $("baseCrashNote").hidden = false;
    }
    if (modelSel.querySelector('option[value="' + fb + '"]')) modelSel.value = fb;
  } else if ($("tinyCrashNote")) {
    $("tinyCrashNote").hidden = false;
  }
}
function applyLangUI() {
  const L = langCfg();
  document.title = "外语跟读 · " + L.name;
  if ($("appTitle")) $("appTitle").textContent = "外语跟读";
  if ($("appSub")) $("appSub").textContent = "当前：" + L.name + "。在手机上选择音视频，生成可跟读的课程。";
  document.querySelectorAll("#langSwitch [data-lang]").forEach((b) => {
    const on = b.dataset.lang === curLang;
    b.setAttribute("aria-pressed", on ? "true" : "false");
    b.classList.toggle("on", on);
  });
  fillModelSelect();
  applyCrashNotes();
}
async function updateResumeBox() {
  try {
    const j = await getLesson(JOB_ID);
    if (j) { $("resumeBox").hidden = false; $("resumeInfo").textContent = `「${j.title}」已识别 ${Math.round(j.doneSec || 0)} / ${Math.round(j.duration || 0)} 秒`; }
    else $("resumeBox").hidden = true;
  } catch (e) { if ($("resumeBox")) $("resumeBox").hidden = true; }
}
async function setLang(id) {
  if (!LANGS[id]) return;
  if (id === curLang) { applyLangUI(); return; }
  curLang = id;
  try { localStorage.setItem("miraa-lang", id); } catch (e) {}
  applyLangUI();
  await refreshLibrary();
  await updateResumeBox();
}

/* ---------------- boot ---------------- */
async function boot() {
  if (!isSecure()) $("secureNote").hidden = false;
  try { const s = localStorage.getItem("miraa-lang"); if (LANGS[s]) curLang = s; } catch (e) {}
  dbg("设备：" + navigator.userAgent.slice(0, 120) + " · deviceMemory=" + (navigator.deviceMemory || "?") + "GB · cores=" + (navigator.hardwareConcurrency || "?") + " · 语言=" + srcName());
  await migrateItalianIfNeeded();
  applyLangUI();
  const sw = $("langSwitch");
  if (sw) sw.addEventListener("click", (e) => { const b = e.target.closest("[data-lang]"); if (b) setLang(b.dataset.lang); });
  modelSel.addEventListener("change", () => {
    const m = modelSel.value;
    const key = confirmKey(m);
    if (m !== langCfg().tiny && !localStorage.getItem(key)) {
      const info = m.includes("small")
        ? "whisper-small 约 242 MB，首次下载较久；识别速度约为 tiny 的 4–6 倍慢，手机可能发烫，内存不足时页面会刷新（会自动退回更小模型）。确定使用？"
        : ((MODELS[m] || {}).enOnly
          ? `${MODELS[m].label} 约 ${MODELS[m].downloadMB} MB，英语专用，通常比多语同一规格更准。确定使用？`
          : `${(MODELS[m] || {}).label || m} 约 ${(MODELS[m] || {}).downloadMB || "?"} MB，首次需下载。确定使用？`);
      if (confirm(info)) localStorage.setItem(key, "1");
      else { modelSel.value = langCfg().tiny; }
    }
    try { localStorage.setItem(modelKey(), modelSel.value); } catch (e) {}
  });
  let srtMediaFile = null;
  $("btnSrt").addEventListener("click", () => { alert("第 1 步：选择音视频文件；第 2 步：选择对应的" + srcName() + " .srt 字幕"); $("srtMedia").click(); });
  $("srtMedia").addEventListener("change", () => { srtMediaFile = $("srtMedia").files[0]; $("srtMedia").value = ""; if (srtMediaFile) $("srtFile").click(); });
  $("srtFile").addEventListener("change", async () => { const f = $("srtFile").files[0]; $("srtFile").value = ""; if (f && srtMediaFile) processWithSrt(srtMediaFile, await f.text()); });
  $("btnVocab").addEventListener("click", showVocab);
  $("btnPick").addEventListener("click", () => filePick.click());
  filePick.addEventListener("change", () => {
    const f = filePick.files && filePick.files[0];
    filePick.value = "";
    if (f) { decodedTitle = (f.name || (srcName() + "跟读")).replace(/\.[^.]+$/, ""); processFile(f); }
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
  renderDebug();
  $("btnClearDbg").addEventListener("click", () => { localStorage.setItem(DBG_KEY, "[]"); renderDebug(); });
  updateResumeBox();
  $("btnResume").addEventListener("click", () => resumeJob());
  $("btnDropJob").addEventListener("click", async () => { await clearJob(); $("resumeBox").hidden = true; });
  window.addEventListener("error", (e) => dbg("JS错误：" + e.message));
  window.addEventListener("unhandledrejection", (e) => dbg("未处理错误：" + ((e.reason && e.reason.message) || e.reason)));
  refreshLibrary();

  window.__miraa = {
    processFile,
    processWithSrt,
    listLessons,
    getLesson,
    putLesson,
    openLesson,
    setLang,
    getLang: () => curLang,
    lookupWord,
    getVocab,
    langCfg,
    tokenizeText,
    toSentenceSegments,
    migrateItalianIfNeeded,
  };
}


boot();
