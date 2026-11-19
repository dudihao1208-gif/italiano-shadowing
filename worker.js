/* Italian ASR worker — transformers.js Whisper, WebGPU then WASM. */
self.postMessage({ type: "log", message: "worker 已启动" });
const ORT = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0-dev.20250409-89f8206ba4/dist/";
let pipeline = null, env = null;
async function initLib(plainWasm) {
  if (!pipeline) {
    self.postMessage({ type: "log", message: "导入 transformers.js…" });
    const m = await import("https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1");
    pipeline = m.pipeline; env = m.env;
    self.postMessage({ type: "log", message: "transformers.js 已导入" });
  }
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  const w = env.backends.onnx.wasm;
  w.numThreads = 1; w.proxy = false;
  if (plainWasm) w.wasmPaths = { mjs: ORT + "ort-wasm-simd-threaded.mjs", wasm: ORT + "ort-wasm-simd-threaded.wasm" };
  self.postMessage({ type: "log", message: "ORT 设置：单线程，" + (plainWasm ? "精简 wasm(11MB, 非 JSEP)" : "默认 wasm") + "，SAB=" + (typeof SharedArrayBuffer !== "undefined") });
}

const RATE = 16000;
const BLOCK = 90 * RATE; // 90 s blocks so a phone can show progress and stay memory-safe

let transcriber = null;
let loaded = { modelId: null, device: null, dtype: null };

function post(msg) {
  self.postMessage(msg);
}

function looksSoftwareGpu(text) {
  const s = String(text || "").toLowerCase();
  return /swiftshader|llvmpipe|softpipe|software|microsoft basic render/.test(s);
}

async function canWebGPU() {
  try {
    if (!navigator.gpu) return false;
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return false;
    let infoText = "";
    try {
      const info = adapter.info || {};
      infoText = [info.vendor, info.architecture, info.description, info.device].filter(Boolean).join(" ");
    } catch (e) {}
    if (!infoText && adapter.requestAdapterInfo) {
      try {
        const info = await adapter.requestAdapterInfo();
        infoText = [info.vendor, info.architecture, info.description, info.device].filter(Boolean).join(" ");
      } catch (e) {}
    }
    if (looksSoftwareGpu(infoText)) {
      post({ type: "log", message: "检测到软件 GPU（" + (infoText || "software") + "），改用 WASM，速度更稳。" });
      return false;
    }
    if (infoText) post({ type: "log", message: "WebGPU 适配器：" + infoText });
    return true;
  } catch {
    return false;
  }
}

function progressCb(phase) {
  return (data) => {
    const file = data && (data.file || data.name) || "";
    const loadedBytes = data && (data.loaded || 0);
    const total = data && (data.total || 0);
    const status = data && data.status;
    let pct = null;
    if (total > 0) pct = Math.min(100, Math.round((loadedBytes / total) * 100));
    else if (typeof data?.progress === "number") pct = Math.round(data.progress);
    post({ type: "progress", phase, status, file, loaded: loadedBytes, total, pct });
  };
}

async function loadModel(modelId, preferGpu) {
  if (transcriber && loaded.modelId === modelId) {
    post({ type: "ready", ...loaded });
    return;
  }
  transcriber = null;
  const attempts = [];
  if (preferGpu && (await canWebGPU())) {
    await initLib(false);
    attempts.push({ device: "webgpu", dtype: "q8" });
  }
  // q8 is the smallest download and lowest memory for whisper (q4 files are larger for tiny/base).
  attempts.push({ device: "wasm", plain: true, dtype: { encoder_model: "q8", decoder_model_merged: "q8" } });
  attempts.push({ device: "wasm", plain: false, dtype: { encoder_model: "q8", decoder_model_merged: "q8" } });

  let lastErr;
  for (const opt of attempts) {
    try {
      post({
        type: "progress",
        phase: "load",
        status: "starting",
        file: `${modelId} · ${opt.device}`,
      });
      await initLib(!!opt.plain);
      post({ type: "log", message: "创建识别管线（初始化 WASM 引擎）…" });
      transcriber = await pipeline("automatic-speech-recognition", modelId, {
        device: opt.device,
        dtype: opt.dtype,
        progress_callback: progressCb("download"),
      });
      post({ type: "log", message: "识别管线就绪" + (opt.plain ? "（精简 wasm）" : "") });
      loaded = { modelId, device: opt.device, dtype: typeof opt.dtype === 'string' ? opt.dtype : 'q8' };
      post({ type: "ready", ...loaded });
      return;
    } catch (err) {
      lastErr = err;
      transcriber = null;
      post({
        type: "log",
        message: `加载失败 ${opt.device}/${opt.dtype}: ${err && err.message ? err.message : err}`,
      });
    }
  }
  throw lastErr || new Error("无法加载语音识别模型");
}

function chunksFrom(result, offsetSec, blockDur) {
  const out = [];
  const chunks = (result && result.chunks) || [];
  if (chunks.length) {
    for (const c of chunks) {
      const text = String(c.text || "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      const ts = c.timestamp || [];
      let start = Number(ts[0]);
      let end = Number(ts[1]);
      if (!Number.isFinite(start)) start = 0;
      if (!Number.isFinite(end) || end < start) end = Math.min(blockDur, start + 4);
      out.push({ start: offsetSec + start, end: offsetSec + end, text });
    }
    return out;
  }
  const text = String((result && result.text) || "").replace(/\s+/g, " ").trim();
  if (text) out.push({ start: offsetSec, end: offsetSec + blockDur, text });
  return out;
}

async function transcribe(audio) {
  if (!transcriber) throw new Error("模型尚未加载");
  const pcm = audio instanceof Float32Array ? audio : new Float32Array(audio);
  const totalSec = pcm.length / RATE;
  const segments = [];
  const opts = {
    language: "italian",
    task: "transcribe",
    return_timestamps: true,
    chunk_length_s: 30,
    stride_length_s: 5,
  };

  // Short clips in one go; longer audio in 90 s blocks for progress + RAM.
  const useBlocks = pcm.length > BLOCK;
  if (!useBlocks) {
    post({ type: "progress", phase: "transcribe", pct: 5, status: "running", doneSec: 0, totalSec });
    const result = await transcriber(pcm, opts);
    segments.push(...chunksFrom(result, 0, totalSec));
    post({ type: "progress", phase: "transcribe", pct: 100, status: "done" });
  } else {
    const step = BLOCK;
    for (let start = 0, i = 0; start < pcm.length; start += step, i++) {
      const end = Math.min(pcm.length, start + step);
      const block = pcm.subarray(start, end);
      const offset = start / RATE;
      post({
        type: "progress",
        phase: "transcribe",
        pct: Math.round((start / pcm.length) * 100),
        status: "running",
        doneSec: offset,
        totalSec,
      });
      const result = await transcriber(block, opts);
      segments.push(...chunksFrom(result, offset, block.length / RATE));
      const pct = Math.min(99, Math.round((end / pcm.length) * 100));
      post({ type: "progress", phase: "transcribe", pct, status: "running", doneSec: end / RATE, totalSec });
    }
  }
  post({ type: "result", segments, duration: totalSec });
}

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  try {
    if (msg.type === "load") {
      await loadModel(msg.modelId, msg.preferGpu !== false);
    } else if (msg.type === "transcribe") {
      await transcribe(msg.audio);
    } else if (msg.type === "chunk") {
      if (!transcriber) throw new Error("模型尚未加载");
      const pcm = msg.audio;
      const r = await transcriber(pcm, { language: "italian", task: "transcribe", return_timestamps: true, chunk_length_s: 30 });
      post({ type: "chunkResult", segments: chunksFrom(r, msg.offset || 0, pcm.length / RATE) });
    } else if (msg.type === "ping") {
      post({ type: "pong" });
    }
  } catch (err) {
    post({ type: "error", message: (err && err.message) || String(err) });
  }
};
