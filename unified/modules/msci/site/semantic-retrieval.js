// 浏览器本机语义检索：Google EmbeddingGemma 2（文本编码器，768 维）经
// Transformers.js 在页面内运行。只下载模型文件；报告文本与向量都不出本机。
// 模型仓库的视觉/音频编码器在加载前剔除，只取 270M 文本部分。
export const SEMANTIC_MODEL_ID = "onnx-community/embeddinggemma-2-ONNX";
export const SEMANTIC_DIMS = 768;
const TRANSFORMERS_URL =
  "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1";
const EMBED_BATCH = 8;
const QUERY_CACHE_LIMIT = 200;

// Background model downloads must not hold up keyword search or assessment.
export async function semanticQueryIfReady(phase, queryTask, timeoutMs = 10000) {
  if (phase !== "ready") return null;
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(queryTask),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("语义检索响应超时")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// EmbeddingGemma 2 非对称检索的任务前缀：查询与文档必须用各自前缀。
export function queryPrefix(text) {
  return "task: search result | query: " + String(text || "").trim();
}
export function documentPrefix(text, title) {
  const name = String(title || "").trim() || "none";
  return "title: " + name + " | text: " + String(text || "").trim();
}

// 向量已按行归一化，点积即余弦相似度。
export function dotRows(vectors, dims, query) {
  const count = Math.floor((vectors?.length || 0) / dims);
  const scores = new Float32Array(count);
  for (let row = 0; row < count; row++) {
    let sum = 0;
    const offset = row * dims;
    for (let d = 0; d < dims; d++) sum += vectors[offset + d] * query[d];
    scores[row] = sum;
  }
  return scores;
}

let enginePromise = null;
const queryCache = new Map();
const indexCache = new WeakMap();

function loadEngine(onProgress) {
  enginePromise ||= (async () => {
    const transformers = await import(TRANSFORMERS_URL);
    const config = await transformers.AutoConfig.from_pretrained(
      SEMANTIC_MODEL_ID,
    );
    // 只保留文本编码器，避免下载与本功能无关的视觉、音频权重。
    config.vision_config = null;
    config.audio_config = null;
    const tokenizer = await transformers.AutoTokenizer.from_pretrained(
      SEMANTIC_MODEL_ID,
    );
    const build = (device) =>
      transformers.AutoModel.from_pretrained(SEMANTIC_MODEL_ID, {
        config,
        device,
        dtype: "q4",
        progress_callback: onProgress,
      });
    let model;
    try {
      model = await build(globalThis.navigator?.gpu ? "webgpu" : "wasm");
    } catch {
      model = await build("wasm");
    }
    return { transformers, tokenizer, model };
  })().catch((error) => {
    enginePromise = null;
    throw error;
  });
  return enginePromise;
}

function normalizeRows(tensor) {
  const dims = tensor.dims[tensor.dims.length - 1];
  const rows = Math.floor(tensor.data.length / dims);
  const out = new Float32Array(rows * dims);
  for (let row = 0; row < rows; row++) {
    const offset = row * dims;
    let norm = 0;
    for (let d = 0; d < dims; d++) norm += tensor.data[offset + d] ** 2;
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < dims; d++) out[offset + d] = tensor.data[offset + d] / norm;
  }
  return { vectors: out, dims };
}

async function embedTexts(engine, texts, onProgress) {
  const collected = [];
  let dims = SEMANTIC_DIMS;
  for (let start = 0; start < texts.length; start += EMBED_BATCH) {
    const batch = texts.slice(start, start + EMBED_BATCH);
    const tokens = engine.tokenizer(batch, {
      padding: true,
      truncation: true,
    });
    const { sentence_embedding } = await engine.model(tokens);
    const rows = normalizeRows(sentence_embedding);
    dims = rows.dims;
    collected.push(rows.vectors);
    if (onProgress)
      onProgress({
        phase: "语义索引",
        completed: Math.min(start + EMBED_BATCH, texts.length),
        total: texts.length,
      });
  }
  const vectors = new Float32Array(texts.length * dims);
  let offset = 0;
  for (const part of collected) {
    vectors.set(part, offset);
    offset += part.length;
  }
  return { vectors, dims };
}

async function embedQuery(engine, query) {
  const key = String(query || "").trim();
  if (!key) return null;
  if (queryCache.has(key)) return queryCache.get(key);
  const { vectors, dims } = await embedTexts(engine, [queryPrefix(key)]);
  const row = vectors.slice(0, dims);
  queryCache.set(key, row);
  if (queryCache.size > QUERY_CACHE_LIMIT)
    queryCache.delete(queryCache.keys().next().value);
  return row;
}

// 为整份报告建立（或复用）语义索引；同一 chunk 数组只计算一次。
export async function semanticIndex(chunks, options = {}) {
  if (!chunks?.length) return null;
  const cached = indexCache.get(chunks);
  if (cached) return cached.promise;
  const promise = (async () => {
    const engine = await loadEngine(options.onModelProgress);
    const texts = chunks.map((chunk) =>
      documentPrefix(chunk.text, chunk.heading),
    );
    const { vectors, dims } = await embedTexts(engine, texts, options.onProgress);
    return { vectors, dims, count: chunks.length, modelId: SEMANTIC_MODEL_ID };
  })();
  indexCache.set(chunks, { promise });
  try {
    return await promise;
  } catch (error) {
    indexCache.delete(chunks);
    throw error;
  }
}

// 返回与 chunks 对齐的余弦相似度；失败时由调用方回退关键词检索。
export async function semanticScores(chunks, query, options = {}) {
  if (!chunks?.length || !String(query || "").trim()) return null;
  const engine = await loadEngine(options.onModelProgress);
  const index = await semanticIndex(chunks, options);
  const row = await embedQuery(engine, query);
  return dotRows(index.vectors, index.dims, row);
}
