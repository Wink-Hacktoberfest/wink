import type { Location, Place, StoredMemory, VisionResult } from './types.ts';

/** Canned data for MOCK=true. Sample images are SVGs the Worker draws at /v1/images/sample-<name>. */

type Sample = VisionResult & { key: string; match: RegExp; color: string; category: string; label: string };

const SAMPLES: Sample[] = [
  {
    key: 'sample-book', match: /book|novel|read/i, color: '#e4572e', category: 'book_store', label: 'book stores',
    title: 'Project Hail Mary', summary: 'A hardcover copy of Project Hail Mary by Andy Weir.',
    visibleText: 'PROJECT HAIL MARY ANDY WEIR', objects: ['book', 'hardcover'], businessName: null,
    productQuery: 'hardcover books',
  },
  {
    key: 'sample-wine', match: /wine|bottle|malbec|drink/i, color: '#8e2c48', category: 'liquor_store', label: 'wine shops',
    title: '2019 Malbec, Mendoza', summary: 'A bottle of 2019 Malbec from Mendoza, Argentina.',
    visibleText: 'MALBEC 2019 MENDOZA ARGENTINA', objects: ['wine bottle', 'label'], businessName: null,
    productQuery: 'red wine',
  },
  {
    key: 'sample-keys', match: /key|car|wallet/i, color: '#f2a541', category: 'hardware_store', label: 'hardware stores',
    title: 'Keys on the kitchen counter', summary: 'A ring of house keys next to the fruit bowl on the counter.',
    visibleText: '', objects: ['keys', 'counter', 'fruit bowl'], businessName: null, productQuery: null,
  },
  {
    key: 'sample-coffee', match: /coffee|cafe|latte|espresso/i, color: '#6b4226', category: 'coffee_shop', label: 'coffee shops',
    title: 'Ethiopia Yirgacheffe beans', summary: 'A bag of light roast Ethiopia Yirgacheffe coffee beans.',
    visibleText: 'ETHIOPIA YIRGACHEFFE LIGHT ROAST', objects: ['coffee bag'], businessName: null,
    productQuery: 'coffee beans',
  },
  {
    key: 'sample-shoes', match: /shoe|sneaker|run/i, color: '#2e86ab', category: 'shoe_store', label: 'shoe stores',
    title: 'Blue trail running shoes', summary: 'A pair of blue trail running shoes with orange laces.',
    visibleText: 'TRAIL 5', objects: ['shoes', 'laces'], businessName: null, productQuery: 'running shoes',
  },
  {
    key: 'sample-plant', match: /plant|flower|leaf/i, color: '#3b8b5a', category: 'florist', label: 'plant shops',
    title: 'Monstera deliciosa', summary: 'A potted monstera plant with large split leaves.',
    visibleText: '', objects: ['plant', 'pot'], businessName: null, productQuery: 'house plants',
  },
];

export const DEMO_FALLBACK_LOCATION: Location = { lat: 35.2059, lng: -97.4457 }; // Norman, OK (Hacklahoma)

function pickSample(text: string, seed: number): Sample {
  return SAMPLES.find((s) => s.match.test(text)) ?? SAMPLES[seed % SAMPLES.length]!;
}

export function mockVision(hint: string | null): VisionResult & { sampleKey: string } {
  const sample = pickSample(hint ?? '', Math.floor(Date.now() / 1000));
  const { key, match: _m, color: _c, category: _cat, label: _l, ...vision } = sample;
  return { ...vision, sampleKey: key };
}

export function seedMemories(now = Date.now()): StoredMemory[] {
  const minutes = [3, 18, 47, 95];
  return [SAMPLES[1]!, SAMPLES[0]!, SAMPLES[2]!, SAMPLES[3]!].map((s, i) => ({
    id: `00000000-0000-4000-8000-00000000000${i + 1}`,
    createdAt: new Date(now - minutes[i]! * 60_000).toISOString(),
    kind: 'explicit' as const,
    title: s.title,
    summary: s.summary,
    visibleText: s.visibleText,
    objects: s.objects,
    note: i === 0 ? 'the wine sam liked' : null,
    imageKey: s.key,
    selection: { mode: i === 0 ? 'point' as const : 'full' as const, box: i === 0 ? { x: 0.31, y: 0.18, w: 0.35, h: 0.4 } : null },
    location: DEMO_FALLBACK_LOCATION,
    place: null,
    productQuery: s.productQuery,
  }));
}

/** Keyword overlap search standing in for the Snowflake vector search. */
export function mockSearch(memories: StoredMemory[], question: string): StoredMemory[] {
  const stop = new Set(['what', 'was', 'that', 'the', 'where', 'did', 'put', 'my', 'is', 'a', 'an', 'of', 'i', 'saw',
    'hey', 'wink', 'which', 'one', 'it', 'this', 'thing', 'to', 'do', 'you', 'remember', 'again', 'me', 'tell']);
  const words = question.toLowerCase().match(/[a-z0-9]+/g)?.filter((w) => !stop.has(w) && w.length > 1) ?? [];
  const scored = memories.map((m) => {
    const hay = `${m.title} ${m.summary} ${m.visibleText} ${m.objects.join(' ')} ${m.note ?? ''}`.toLowerCase();
    const score = words.reduce((sum, w) => sum + (hay.includes(w) || hay.includes(w.replace(/s$/, '')) ? 1 : 0), 0);
    return { m, score };
  }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  return scored.slice(0, 3).map((s) => s.m);
}

export function mockNearby(query: string, location: Location): { label: string; places: Place[] } {
  const sample = pickSample(query, 0);
  const names: Record<string, string[]> = {
    book_store: ['Gray Owl Books', 'Second Chapter Used Books', 'Barnes & Noble'],
    liquor_store: ['Vintage Cellar Wine & Spirits', 'Corner Bottle Shop', 'Total Wine & More'],
    hardware_store: ['Ace Hardware', 'Main Street Locksmith', 'The Home Depot'],
    coffee_shop: ['Second Wind Coffee', 'Gray Owl Coffee', 'Starbucks'],
    shoe_store: ['Run Norman', 'Foot Locker', 'DSW Designer Shoe Warehouse'],
    florist: ['Bloom Plant Co.', 'Green Thumb Nursery', 'Trader Joe\'s Flowers'],
  };
  const offsets = [[0.0031, 0.0012, 380], [-0.0052, 0.0061, 840], [0.0102, -0.0088, 1460]] as const;
  const places = (names[sample.category] ?? names.book_store!).map((name, i) => {
    const [dLat, dLng, meters] = offsets[i]!;
    return {
      id: `08f2a1${sample.category.slice(0, 4)}0000${i}`,
      name,
      category: sample.category,
      address: `${120 + i * 211} ${['E Main St', 'W Boyd St', 'N Porter Ave'][i]}, Norman, OK`,
      phone: `+1405555${String(1200 + i * 37).padStart(4, '0')}`,
      lat: Math.round((location.lat + dLat) * 1e6) / 1e6,
      lng: Math.round((location.lng + dLng) * 1e6) / 1e6,
      distanceMeters: meters,
    };
  });
  return { label: sample.label, places };
}

export function mockGlanceSpeech(v: VisionResult): string {
  return `That looks like ${v.title}. ${v.summary}`;
}

const ICONS: Record<string, string> = {
  book: '<rect x="230" y="120" width="180" height="240" rx="8" fill="#fff3"/><rect x="250" y="150" width="140" height="18" rx="4" fill="#fff9"/><rect x="250" y="180" width="100" height="12" rx="4" fill="#fff6"/>',
  wine: '<rect x="295" y="100" width="50" height="80" rx="10" fill="#fff4"/><rect x="270" y="170" width="100" height="200" rx="30" fill="#fff3"/><rect x="285" y="230" width="70" height="70" rx="6" fill="#fff8"/>',
  keys: '<circle cx="280" cy="220" r="50" fill="none" stroke="#fff9" stroke-width="16"/><rect x="320" y="212" width="130" height="16" rx="8" fill="#fff9"/><rect x="420" y="228" width="16" height="30" fill="#fff9"/>',
  coffee: '<rect x="240" y="140" width="160" height="210" rx="18" fill="#fff3"/><circle cx="320" cy="245" r="40" fill="#fff6"/>',
  shoes: '<path d="M170 300 Q200 200 300 230 L470 280 Q490 330 450 340 L180 340 Z" fill="#fff5"/>',
  plant: '<ellipse cx="290" cy="190" rx="60" ry="90" fill="#fff5" transform="rotate(-25 290 190)"/><ellipse cx="360" cy="200" rx="55" ry="85" fill="#fff4" transform="rotate(25 360 200)"/><rect x="270" y="280" width="100" height="80" rx="10" fill="#fff6"/>',
};

/** Placeholder art for the canned memories so the TV grid looks real without R2. */
export function sampleImageSvg(key: string): string | null {
  const sample = SAMPLES.find((s) => s.key === key);
  if (!sample) return null;
  const icon = ICONS[key.replace('sample-', '')] ?? '';
  const title = sample.title.replace(/[<&>"]/g, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${sample.color}"/><stop offset="1" stop-color="#111"/></linearGradient></defs>
<rect width="640" height="480" fill="url(#g)"/>${icon}
<text x="32" y="440" font-family="Helvetica, Arial, sans-serif" font-size="30" font-weight="700" fill="#fff">${title}</text>
</svg>`;
}
