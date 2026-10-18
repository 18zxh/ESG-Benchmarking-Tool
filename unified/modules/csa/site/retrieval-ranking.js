// Shared retrieval mechanics; CSA applicability and scoring stay in the question data.
const stop = new Set(('the and for with from that this your have has are was were will can may must should shall which what when where how does into than their its our any all not only also each same such these those company companies report reporting information provide please indicate question questions assessment sustainability sustainable following publicly available evidence data').split(' '));
const indexCache = new WeakMap();

export function searchTokens(value) {
  const text = String(value || '').normalize('NFKC').toLowerCase();
  const tokens = text.match(/[a-z][a-z0-9-]{2,}|\d{4}|[\u4e00-\u9fff]{2,}/g) || [];
  return tokens.flatMap((word) => /[\u4e00-\u9fff]/.test(word)
    ? Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2))
    : stop.has(word) ? [] : [word]);
}

export function questionQueries(question, title, custom = '') {
  const layout = String(question.layout || '').replace(/\r/g, '');
  const lead = layout.split(/\n\s*(?:Question|Data Requirements|Supporting evidence|References|Question-Specific|Assessment Focus)\b/i)[0];
  const parts = lead.split(/\n\s*\n|(?<=[?.])\s*\n/).map((x) => x.replace(/\s+/g, ' ').trim()).filter((x) => x.length >= 25);
  const base = [title, question.title, custom].filter(Boolean).join(' · ');
  const queries = [base + '\n' + (parts[0] || lead).slice(0, 1200)];
  for (const part of parts.slice(1, 3)) queries.push(base + '\n' + part.slice(0, 1000));
  if (question.guidance) queries.push(base + '\n' + String(question.guidance).replace(/\s+/g, ' ').slice(0, 1400));
  return [...new Set(queries)].slice(0, 4);
}

function keywordIndex(chunks) {
  if (indexCache.has(chunks)) return indexCache.get(chunks);
  const df = new Map();
  const docs = chunks.map((chunk) => {
    const tokens = searchTokens(chunk.text), tf = new Map();
    for (const word of tokens) tf.set(word, (tf.get(word) || 0) + 1);
    for (const word of tf.keys()) df.set(word, (df.get(word) || 0) + 1);
    return { tf, length: tokens.length || 1 };
  });
  const index = { docs, df, average: docs.reduce((s, d) => s + d.length, 0) / (docs.length || 1) };
  indexCache.set(chunks, index);
  return index;
}

export function keywordScores(chunks, queries) {
  const index = keywordIndex(chunks), terms = [...new Set(searchTokens(queries.join('\n')))].slice(0, 350);
  return index.docs.map((doc) => terms.reduce((score, term) => {
    const frequency = doc.tf.get(term) || 0;
    if (!frequency) return score;
    const idf = Math.log(1 + (chunks.length - index.df.get(term) + 0.5) / (index.df.get(term) + 0.5));
    return score + idf * frequency * 2.2 / (frequency + 1.2 * (0.25 + 0.75 * doc.length / index.average));
  }, 0));
}

export function rankCandidates(rows) {
  const lexical = [...rows].filter((r) => r.matchScore >= 2 || r.keywordScore >= 2).sort((a, b) => b.keywordScore + b.matchScore - a.keywordScore - a.matchScore);
  const lexicalRanks = new Map(lexical.map((r, i) => [r.id, i + 1]));
  return rows.filter((r) => lexicalRanks.has(r.id)).map((r) => {
    const lex = lexicalRanks.get(r.id);
    const quality = r.requiresReview || r.contextComplete === false ? 0.35 : 1;
    return { ...r,
      retrievalRank: quality / (60 + lex),
      matchType: '关键词',
      autoSelect: Boolean(lex && r.matchScore >= 4 && quality === 1),
    };
  }).sort((a, b) => b.retrievalRank - a.retrievalRank || a.page - b.page);
}
