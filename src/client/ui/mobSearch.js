// ── Mob search (mob gallery) ─────────────────────────────────────────────────
// Pure search logic for the mob gallery — no DOM, no game state. The gallery
// builds an index once (buildMobIndex) and runs every keystroke through
// searchMobs().
//
// Query language (all case-insensitive):
//   bee               mob names AND drops — "stinger" finds every mob that
//                     drops Stinger; several words must all match
//   worker ant        multi-word names work as-is
//   mob:bee  m:bee    mob names only
//   drop:ant_egg      drops only (d:, petal:, p: too; "_" stands for a space)
//   mythic            one rarity column; mythic+ / mythic- for and up / and down
//   r:mythic          same, explicit
//   garden            biome (garden / desert / ocean, or b:garden)
//   found / missing   discovered or undiscovered tiles; complete = all found
//   -ant              exclude anything matching
//   bee, hornet       either (comma or "or" separates alternatives)
// Typos are forgiven (one letter off, two for long words).

const STATUS_WORDS = {
  found: 'found', discovered: 'found', unlocked: 'found', killed: 'found',
  missing: 'missing', undiscovered: 'missing', locked: 'missing', unfound: 'missing',
  complete: 'complete', completed: 'complete',
};
const FIELD_ALIASES = {
  mob: 'mob', m: 'mob', name: 'mob',
  drop: 'drop', drops: 'drop', d: 'drop', petal: 'drop', p: 'drop',
  rarity: 'rarity', r: 'rarity', tier: 'rarity',
  biome: 'biome', b: 'biome',
  is: 'is', status: 'is',
};

const norm = s => String(s).toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

/** Levenshtein distance, capped early at `max + 1`. */
function lev(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** How well word/phrase `w` matches `text` (0 = not at all). */
export function textScore(text, w) {
  if (!w) return 0;
  if (text === w) return 100;
  if (text.startsWith(w)) return 85;
  if ((' ' + text).includes(' ' + w)) return 70;
  if (text.includes(w)) return 50;
  if (w.length >= 4 && !w.includes(' ')) {
    const tol = w.length >= 7 ? 2 : 1;
    for (const word of text.split(' ')) {
      if (lev(w, word, tol) <= tol) return 30;
      if (word.length > w.length && lev(w, word.slice(0, w.length), 1) <= 1) return 22;
    }
  }
  return 0;
}

/**
 * @param {string[]} types                 gallery mob ids, in display order
 * @param {object}   o
 * @param {string[]} o.rarities            rarity names by tier
 * @param {(id)=>string}   o.nameOf        display name
 * @param {(id)=>string[]} [o.altNamesOf]  extra names that also match
 * @param {(id, tier)=>string[]} o.dropsOf petal display names droppable at a mob tier
 * @param {(id)=>string|null}    o.biomeOf
 */
export function buildMobIndex(types, o) {
  const tiers = o.rarities.length;
  const entries = types.map((typeId, order) => {
    const label = o.nameOf(typeId);
    const names = [...new Set([label, typeId, ...(o.altNamesOf?.(typeId) ?? [])].map(norm))];
    const drops = new Map();   // lower name → { label, tiers: Uint8Array }
    for (let t = 0; t < tiers; t++) {
      for (const dl of o.dropsOf(typeId, t)) {
        const k = norm(dl);
        if (!drops.has(k)) drops.set(k, { label: dl, tiers: new Uint8Array(tiers) });
        drops.get(k).tiers[t] = 1;
      }
    }
    return { typeId, order, label, name: norm(label), names, drops, biome: o.biomeOf(typeId) };
  });

  const dropLabels = new Map();  // lower → { label, count }
  for (const e of entries) for (const [k, d] of e.drops) {
    const cur = dropLabels.get(k) ?? { label: d.label, count: 0 };
    cur.count++;
    dropLabels.set(k, cur);
  }
  const biomes = new Map();
  for (const e of entries) if (e.biome) biomes.set(e.biome, (biomes.get(e.biome) ?? 0) + 1);
  const words = new Set();
  for (const e of entries) {
    for (const n of e.names) for (const w of n.split(' ')) words.add(w);
    for (const k of e.drops.keys()) for (const w of k.split(' ')) words.add(w);
  }
  return { entries, tiers, rarities: o.rarities.map(norm), rarityLabels: o.rarities, dropLabels, biomes,
           words: [...words] };
}

// ── Parsing ──────────────────────────────────────────────────────────────────
function rarityRange(index, word) {
  const m = /^(.+?)([+-]?)$/.exec(word);
  const base = m[1], dir = m[2];
  const tier = index.rarities.indexOf(base);
  if (tier < 0) return null;
  const set = new Set();
  const lo = dir === '+' ? tier : dir === '-' ? 0 : tier;
  const hi = dir === '+' ? index.tiers - 1 : tier;
  for (let t = lo; t <= hi; t++) set.add(t);
  return set;
}

/** Turns the query text into OR-clauses of terms. */
export function parseQuery(index, text) {
  const clauses = [];
  for (const part of text.toLowerCase().split(/,|\s+or\s+/)) {
    const cl = { free: [], neg: [], mob: [], drop: [], rarity: null, notRarity: new Set(),
                 biome: new Set(), notBiome: new Set(), is: new Set(), notIs: new Set() };
    let any = false;
    for (let tok of part.trim().split(/\s+/)) {
      if (!tok || tok === '-') continue;
      let neg = false;
      if (tok.length > 1 && tok[0] === '-' ) { neg = true; tok = tok.slice(1); }
      let field = null, value = tok;
      const colon = tok.indexOf(':');
      if (colon > 0 && FIELD_ALIASES[tok.slice(0, colon)]) {
        field = FIELD_ALIASES[tok.slice(0, colon)];
        value = tok.slice(colon + 1);
        if (!value) continue;   // still typing "drop:"
      }
      value = norm(value);
      any = true;

      // Half-typed rarity / biome ("myth", "gard") counts once nothing else starts that way
      if (field === null && value.length >= 3 && !index.words.some(w => w.startsWith(value))) {
        const r = index.rarities.find(x => x.startsWith(value.replace(/[+-]$/, '')));
        const b = [...index.biomes.keys()].find(x => x.startsWith(value));
        if (r && !b) value = r + (/[+-]$/.test(value) ? value.slice(-1) : '');
        else if (b && !r) value = b;
      }
      const asRarity = (field === null || field === 'rarity') ? rarityRange(index, value) : null;
      if (asRarity) {
        if (neg) for (const t of asRarity) cl.notRarity.add(t);
        else cl.rarity = cl.rarity ? new Set([...cl.rarity].filter(t => asRarity.has(t))) : asRarity;
        continue;
      }
      if ((field === null || field === 'biome') && index.biomes.has(value)) {
        (neg ? cl.notBiome : cl.biome).add(value); continue;
      }
      if ((field === null || field === 'is') && STATUS_WORDS[value]) {
        (neg ? cl.notIs : cl.is).add(STATUS_WORDS[value]); continue;
      }
      if (field === 'rarity' || field === 'biome' || field === 'is') { cl.bad = true; continue; }
      if (neg) cl.neg.push({ field, value });
      else if (field === 'mob') cl.mob.push(value);
      else if (field === 'drop') cl.drop.push(value);
      else cl.free.push(value);
    }
    if (any) clauses.push(cl);
  }
  return clauses;
}

// ── Matching ─────────────────────────────────────────────────────────────────
function nameScore(e, w) {
  let s = 0;
  for (const n of e.names) s = Math.max(s, textScore(n, w));
  return s;
}
/** Drops matching `w`, keeping only the close-to-best ones. */
function dropMatches(e, w) {
  let best = 0;
  const hits = [];
  for (const [k, d] of e.drops) {
    const s = textScore(k, w);
    if (s > 0) { hits.push({ k, d, s }); best = Math.max(best, s); }
  }
  return { best, hits: hits.filter(h => h.s >= best - 15) };
}

function evalClause(e, cl, discovered) {
  if (cl.bad) return null;
  const T = discovered.length;
  const mask = new Uint8Array(T).fill(1);
  let tileFilter = false, score = 0;
  const drops = new Set();
  const nameWords = [];

  if (cl.rarity) { tileFilter = true; for (let t = 0; t < T; t++) if (!cl.rarity.has(t)) mask[t] = 0; }
  for (const t of cl.notRarity) { tileFilter = true; mask[t] = 0; }
  if (cl.biome.size && !cl.biome.has(e.biome)) return null;
  if (cl.notBiome.has(e.biome)) return null;

  const all = discovered.every(Boolean);
  if (cl.is.has('complete') && !all) return null;
  if (cl.notIs.has('complete') && all) return null;
  const wantFound = cl.is.has('found') || cl.notIs.has('missing');
  const wantMissing = cl.is.has('missing') || cl.notIs.has('found');
  if (wantFound) { tileFilter = true; for (let t = 0; t < T; t++) if (!discovered[t]) mask[t] = 0; }
  if (wantMissing) { tileFilter = true; for (let t = 0; t < T; t++) if (discovered[t]) mask[t] = 0; }

  for (const w of cl.mob) {
    const s = nameScore(e, w);
    if (!s) return null;
    score += s; nameWords.push(w);
  }
  const applyDrops = hits => {
    tileFilter = true;
    const m = new Uint8Array(T);
    for (const h of hits) { drops.add(h.d.label); for (let t = 0; t < T; t++) if (h.d.tiers[t]) m[t] = 1; }
    for (let t = 0; t < T; t++) mask[t] &= m[t];
  };
  for (const w of cl.drop) {
    const { best, hits } = dropMatches(e, w);
    if (!best) return null;
    score += best; applyDrops(hits);
  }

  // Free words: the whole phrase first ("ant egg" as one drop / name) …
  if (cl.free.length) {
    const phrase = cl.free.join(' ');
    const pn = nameScore(e, phrase);
    const pd = cl.free.length > 1 ? dropMatches(e, phrase) : { best: 0, hits: [] };
    if (cl.free.length > 1 && (pn >= 50 || pd.best >= 50)) {
      if (pn >= pd.best) { score += pn + 40; nameWords.push(phrase); }
      else { score += pd.best * 0.8 + 30; applyDrops(pd.hits); }
    } else {
      // … otherwise every word has to land on the name or a drop
      for (const w of cl.free) {
        const ns = nameScore(e, w);
        const dm = dropMatches(e, w);
        if (!ns && !dm.best) return null;
        if (ns >= dm.best * 0.75) { score += ns; nameWords.push(w); }
        else { score += dm.best * 0.75; applyDrops(dm.hits); }
      }
    }
  }

  for (const n of cl.neg) {
    if (n.field !== 'drop' && nameScore(e, n.value) >= 50) return null;
    if (n.field !== 'mob' && dropMatches(e, n.value).best >= 50) return null;
  }

  if (tileFilter && !mask.some(Boolean)) return null;
  return { score, mask, drops, nameWords };
}

/**
 * Runs `text` over the index.
 * @param {(typeId)=>boolean[]} discoveredOf   per-tier discovery
 * @returns {{ results: Map<typeId, {score, mask, drops:Set, nameWords}>, order: string[], ranked: boolean, active: boolean }}
 */
export function searchMobs(index, text, discoveredOf) {
  const clauses = parseQuery(index, text);
  const results = new Map();
  let ranked = false;
  for (const cl of clauses) if (cl.free.length || cl.mob.length || cl.drop.length) ranked = true;

  for (const e of index.entries) {
    const disc = discoveredOf(e.typeId);
    if (!clauses.length) {
      results.set(e.typeId, { score: 0, mask: new Uint8Array(index.tiers).fill(1), drops: new Set(), nameWords: [] });
      continue;
    }
    let best = null;
    for (const cl of clauses) {
      const r = evalClause(e, cl, disc);
      if (!r) continue;
      if (!best) { best = r; continue; }
      // Either clause: union the tiles and drops, keep the better score
      for (let t = 0; t < r.mask.length; t++) best.mask[t] |= r.mask[t];
      for (const d of r.drops) best.drops.add(d);
      best.nameWords.push(...r.nameWords);
      best.score = Math.max(best.score, r.score);
    }
    if (best) results.set(e.typeId, best);
  }
  const order = index.entries.filter(e => results.has(e.typeId))
    .sort((a, b) => ranked ? (results.get(b.typeId).score - results.get(a.typeId).score) || (a.order - b.order)
                           : a.order - b.order)
    .map(e => e.typeId);
  return { results, order, ranked, active: clauses.length > 0 };
}

/** Closest known mob or drop name to what was typed, for "did you mean". */
export function didYouMean(index, text) {
  const q = norm(text.replace(/^-|[a-z]+:/g, ''));
  if (q.length < 3) return null;
  let best = null, bestD = 4;
  const consider = label => {
    const d = lev(q, norm(label), 3);
    if (d < bestD) { bestD = d; best = label; }
  };
  for (const e of index.entries) consider(e.label);
  for (const { label } of index.dropLabels.values()) consider(label);
  return best;
}
