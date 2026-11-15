#!/usr/bin/env node
// Lấy tin tuyển dụng remote từ các nguồn có API/RSS công khai, lọc theo
// 4 nhóm việc (SEO/Content, AI training, Dịch thuật, Trợ lý ảo/Marketing),
// tách phần "Yêu cầu", đọc mức lương, quy đổi ra VNĐ, dịch sang tiếng Việt
// rồi ghi ra remote-jobs/jobs.json cho trang index.html đọc.
// Chạy: node remote-jobs/fetch-jobs.mjs   (Node 18+, không cần cài thêm gì)

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'jobs.json');
const MAX_AGE_DAYS = 30;
const MAX_NEW_TRANSLATIONS = 200; // giới hạn số tin dịch mới mỗi lần chạy
const UA = 'Mozilla/5.0 (compatible; personal-remote-job-feed/1.0)';

// Bản jobs.json đang chạy trên GitHub Pages: dùng lại bản dịch cũ, khỏi dịch lại.
const PREV_URL =
  process.env.PREV_JOBS_URL ||
  (process.env.GITHUB_REPOSITORY
    ? (([o, r]) => `https://${o.toLowerCase()}.github.io/${r}/jobs.json`)(process.env.GITHUB_REPOSITORY.split('/'))
    : '');

// ---------- Phân loại ----------
// Khớp trên tiêu đề + tag (không khớp trên mô tả để tránh nhiễu).
export const CATEGORIES = {
  seo: [
    /\bseo\b/, /search engine/, /content writ/, /copywrit/, /content market/,
    /blog (writer|post)/, /link ?build/, /content strateg/, /content editor/,
    /technical writer/, /\bwriter\b/, /content creator/, /content specialist/,
  ],
  ai: [
    /\bai (trainer|tutor|writer|rater|evaluator|data|content|annotat)/, /data annotat/,
    /annotator/, /\brater\b/, /search quality/, /ad(s)? quality/, /\brlhf\b/,
    /prompt (engineer|writer)/, /\bllm\b/, /data label/, /ai training/,
    /model (evaluat|train)/, /response evaluat/, /generative ai/, /\bevaluator\b/,
  ],
  translation: [
    /translat/, /locali[sz]/, /vietnamese/, /interpret/, /\bmtpe\b/,
    /post[- ]?edit/, /linguist/, /transcri/, /subtitl/, /bilingual/,
  ],
  va: [
    /virtual assistant/, /social media/, /community manag/, /marketing (assistant|coordinator|specialist|associate)/,
    /executive assistant/, /admin(istrative)? assistant/, /personal assistant/,
    /digital marketing/, /email marketing/, /\bva\b/, /growth marketer/, /content moderat/,
  ],
};

const EXCLUDE = [/\bsenior (software|backend|frontend|full[- ]?stack)/, /\bengineering manager\b/, /\bdevops\b/];

export function classify(text) {
  const t = text.toLowerCase();
  if (EXCLUDE.some((r) => r.test(t))) return [];
  return Object.entries(CATEGORIES)
    .filter(([, rs]) => rs.some((r) => r.test(t)))
    .map(([k]) => k);
}

// Khu vực: việc có nhận người ở Việt Nam không?
const OPEN_GEO = /(worldwide|anywhere|global|international|asia|apac|vietnam|viet nam|southeast|sea\b|remote$|^$|no restriction|all countries)/i;
export const geoOpen = (loc) => OPEN_GEO.test((loc || '').trim());

const FLEX = /(freelance|contract|part[- ]?time|hourly|temporary|flexible|gig|per task)/i;

// ---------- Xử lý văn bản ----------
const decode = (s = '') =>
  s
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&rsquo;|&lsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&ndash;|&mdash;/g, '-')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, '&');

// HTML -> các dòng chữ (giữ cấu trúc đầu mục để tìm phần "Yêu cầu").
export function htmlToLines(html = '') {
  let s = String(html);
  if (/&lt;\/?[a-z]/i.test(s)) s = decode(s); // RSS hay chứa HTML bị mã hoá
  s = s
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<(br|\/p|\/div|\/h\d|\/li|\/ul|\/ol|p|div|h\d|ul|ol)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decode(s)
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

const strip = (html = '') => htmlToLines(html).join(' ').replace(/^• /, '').replace(/\s+/g, ' ').trim();

const cut = (t, n) => (t.length > n ? t.slice(0, n).replace(/\s\S*$/, '') + '…' : t);

const REQ_HEAD = /(requirement|qualification|what you('ll)? (need|bring)|what we('re| are) looking for|who you are|you (have|are|bring)|must[- ]have|skills|about you|ideal candidate|you should|you will need|we('d)? love|nice to have)/i;
const OTHER_HEAD = /(responsibilit|what you('ll)? do|duties|benefit|perks|about (us|the company|the role)|what we offer|compensation|why (join|work)|how to apply|salary|our (team|company)|the role|tasks|day to day)/i;
const REQ_WORD = /\b(experience|years?|fluent|english|proficien|degree|skill|knowledge|ability|able to|must|required|familiar|native|strong)\b/i;

// Tách phần "Yêu cầu" của tin tuyển dụng.
export function extractRequirements(html) {
  const lines = htmlToLines(html);
  const isHead = (l) => l.length < 70 && !l.startsWith('• ');
  let start = lines.findIndex((l) => isHead(l) && REQ_HEAD.test(l));
  let picked = [];
  if (start >= 0) {
    for (let i = start + 1; i < lines.length && picked.length < 8; i++) {
      const l = lines[i];
      if (isHead(l) && OTHER_HEAD.test(l) && picked.length) break;
      if (isHead(l) && REQ_HEAD.test(l)) continue;
      picked.push(l);
    }
  }
  if (!picked.length) picked = lines.filter((l) => l.startsWith('• ') && REQ_WORD.test(l)).slice(0, 6);
  return picked.map((l) => cut(l.replace(/^•\s*/, ''), 220)).filter((l) => l.length > 3);
}

// Gợi ý nhanh từ mô tả: số năm kinh nghiệm, có cần nói/họp không.
export function hints(text) {
  const y = text.match(/(\d{1,2})\+?\s*(?:-\s*\d+\s*)?years?(?:'| of)?\s*(?:of\s+)?(?:\w+\s+){0,3}experience/i);
  const years = y ? +y[1] : null;
  const speaking = /(phone calls?|video calls?|zoom|client calls|meetings|spoken english|verbal communication|speak(ing)? (fluent )?english|cold call)/i.test(text);
  const async = /(async|asynchronous|no (calls|meetings)|flexible (hours|schedule)|work at your own pace|own schedule)/i.test(text);
  return { years: years && years < 20 ? years : null, speaking, async };
}

// ---------- Lương ----------
const CUR = { $: 'USD', 'us$': 'USD', usd: 'USD', '€': 'EUR', eur: 'EUR', '£': 'GBP', gbp: 'GBP', cad: 'CAD', aud: 'AUD' };
const PER = (p = '') => {
  p = p.toLowerCase();
  if (/^(hour|hr|h)/.test(p)) return 'hour';
  if (/^(month|mo)/.test(p)) return 'month';
  if (/^(year|yr|annum|annual)/.test(p)) return 'year';
  if (/^week/.test(p)) return 'week';
  if (/^day/.test(p)) return 'day';
  return '';
};
const HOURS = { hour: 1, day: 8, week: 40, month: 160, year: 1920 };
const num = (s, k) => {
  const n = parseFloat(String(s).replace(/,/g, ''));
  return k ? n * 1000 : n;
};
const guessPeriod = (v) => (v < 300 ? 'hour' : v < 20000 ? 'month' : 'year');
const plausible = (v, p) =>
  ({ hour: [3, 400], day: [20, 3000], week: [100, 15000], month: [300, 40000], year: [4000, 600000] }[p] || [0, 0]).every(
    (b, i) => (i ? v <= b : v >= b),
  );

// Đọc mức lương từ chuỗi chữ, ví dụ "$20-30/hr", "USD 50k – 70k per year", "40 - 60 USD/hour".
export function parseSalary(text = '') {
  const t = String(text);
  const C = String.raw`(US\$|\$|USD|€|EUR|£|GBP|CAD|AUD)`;
  const N = String.raw`(\d{1,3}(?:[,.]\d{3})+|\d+(?:\.\d+)?)\s*(k\b|K\b)?(?!\s*(?:m\b|mm\b|b\b|bn\b|million|billion|\+|%))`;
  const P = String.raw`(?:\s*(?:\/|per|an?|each)\s*(hour|hr|h\b|month|mo\b|year|yr|annum|week|day))?`;
  const pats = [
    new RegExp(`${C}\\s?${N}(?:\\s*(?:-|–|to)\\s*${C}?\\s?${N})?\\s*(?:USD|EUR|GBP)?${P}`, 'i'),
    new RegExp(`${N}(?:\\s*(?:-|–|to)\\s*${N})?\\s*${C}${P}`, 'i'),
  ];
  for (const [i, re] of pats.entries()) {
    const m = t.match(re);
    if (!m) continue;
    let cur, a, ak, b, bk, per;
    if (i === 0) [, cur, a, ak, , b, bk, per] = m;
    else [, a, ak, b, bk, cur, per] = m;
    let min = num(a, ak);
    let max = b ? num(b, bk || ak) : min;
    if (!b && ak) max = min;
    if (bk && !ak && min < 1000) min *= 1000; // "50-70k"
    if (max < min) [min, max] = [max, min];
    // Một con số nhỏ không có "/giờ, /tháng…" thì không đủ tin là lương.
    if (!PER(per) && !b && max < 1000) continue;
    const period = PER(per) || guessPeriod(max);
    if (!plausible(max, period)) continue;
    return { min, max, currency: CUR[cur.toLowerCase()] || 'USD', period };
  }
  return null;
}

function buildSalary(s, rates) {
  if (!s || !(s.min || s.max)) return null;
  const min = s.min || s.max, max = s.max || s.min;
  const period = s.period || guessPeriod(max);
  const toUsd = (v) => v / (rates[s.currency] || 1);
  const hMin = toUsd(min) / HOURS[period], hMax = toUsd(max) / HOURS[period];
  const vnd = rates.VND;
  return {
    min, max, currency: s.currency || 'USD', period,
    usdHourMin: +hMin.toFixed(2), usdHourMax: +hMax.toFixed(2),
    vndHourMin: Math.round(hMin * vnd), vndHourMax: Math.round(hMax * vnd),
  };
}

// ---------- Mạng ----------
async function get(url, as = 'json') {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return as === 'json' ? await res.json() : await res.text();
  } finally {
    clearTimeout(timer);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getRates() {
  const fallback = { USD: 1, VND: 26300, EUR: 0.86, GBP: 0.75, CAD: 1.39, AUD: 1.52 };
  try {
    const d = await get('https://open.er-api.com/v6/latest/USD');
    if (d?.rates?.VND) return { ...fallback, ...d.rates, _live: true };
  } catch (e) {
    console.warn(`✗ Tỷ giá: ${e.message}, dùng tỷ giá dự phòng`);
  }
  return fallback;
}

// Dịch sang tiếng Việt qua endpoint công khai của Google Translate.
// Gặp HTTP 429 (gửi quá nhiều) thì chờ rồi thử lại.
async function translate(text, tries = 3) {
  if (!text) return '';
  for (let i = 0; ; i++) {
    try { return await translateOnce(text); }
    catch (e) {
      if (i + 1 >= tries || !/429|5\d\d/.test(e.message)) throw e;
      await sleep(15000 * (i + 1));
    }
  }
}

async function translateOnce(text) {
  const res = await fetch('https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=vi&dt=t', {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: 'q=' + encodeURIComponent(text.slice(0, 4500)),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const d = await res.json();
  return (d?.[0] || []).map((seg) => seg?.[0] || '').join('').trim();
}

function rssItems(xml) {
  const tag = (block, name) => {
    const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
    return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
  };
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((m) => ({
    title: strip(tag(m[1], 'title')),
    link: strip(tag(m[1], 'link')),
    pubDate: tag(m[1], 'pubDate'),
    region: strip(tag(m[1], 'region')),
    type: strip(tag(m[1], 'type')),
    category: strip(tag(m[1], 'category')),
    description: tag(m[1], 'description'),
  }));
}

// ---------- Nguồn ----------
// Mỗi hàm trả về mảng job thô:
// {title, company, url, date, location, type, salaryText, salary?, tags, description}
const yearly = (min, max, currency) =>
  min || max ? { min: +min || +max, max: +max || +min, currency: currency || 'USD', period: (+max || +min) < 300 ? 'hour' : 'year' } : null;

const SOURCES = {
  async Remotive() {
    const searches = ['seo', 'content writer', 'copywriter', 'translation', 'translator', 'vietnamese', 'virtual assistant', 'social media', 'ai trainer', 'annotation', 'data labeling'];
    const out = [];
    for (const q of searches) {
      const d = await get(`https://remotive.com/api/remote-jobs?search=${encodeURIComponent(q)}&limit=100`);
      for (const j of d.jobs || []) {
        out.push({
          title: j.title, company: j.company_name, url: j.url, date: j.publication_date,
          location: j.candidate_required_location, type: j.job_type, salaryText: j.salary || '',
          tags: [...(j.tags || []), j.category || ''], description: j.description,
        });
      }
    }
    return out;
  },

  async RemoteOK() {
    // Điều khoản của Remote OK: phải ghi nguồn và dẫn link về remoteok.com (trang đã làm).
    const d = await get('https://remoteok.com/api');
    return d.filter((j) => j && j.position).map((j) => ({
      title: j.position, company: j.company, url: j.url || `https://remoteok.com/remote-jobs/${j.id}`,
      date: j.date, location: j.location, type: '', salary: yearly(j.salary_min, j.salary_max, 'USD'),
      tags: j.tags || [], description: j.description,
    }));
  },

  async Jobicy() {
    // Một số tag có thể bị API từ chối (HTTP 400): bỏ qua tag đó, vẫn lấy các tag khác.
    const queries = ['', 'tag=seo', 'tag=copywriting', 'tag=translation', 'tag=marketing', 'industry=marketing', 'industry=copywriting'];
    const out = [];
    let okCount = 0, lastErr;
    for (const q of queries) {
      let d;
      try { d = await get(`https://jobicy.com/api/v2/remote-jobs?count=50${q ? '&' + q : ''}`); okCount++; }
      catch (e) { lastErr = e; continue; }
      for (const j of d.jobs || []) {
        out.push({
          title: j.jobTitle, company: j.companyName, url: j.url, date: j.pubDate,
          location: j.jobGeo, type: Array.isArray(j.jobType) ? j.jobType.join(', ') : j.jobType || '',
          salary: yearly(j.annualSalaryMin, j.annualSalaryMax, j.salaryCurrency),
          tags: [...(Array.isArray(j.jobIndustry) ? j.jobIndustry : [j.jobIndustry || ''])],
          description: j.jobDescription || j.jobExcerpt,
        });
      }
    }
    if (!okCount) throw lastErr;
    return out;
  },

  async Himalayas() {
    // API trả tối đa ~20 tin/trang: lật trang theo số tin thực nhận, tối đa 25 trang.
    const out = [];
    for (let offset = 0, page = 0; page < 25; page++) {
      const d = await get(`https://himalayas.app/jobs/api?limit=20&offset=${offset}`);
      const jobs = d.jobs || [];
      offset += jobs.length;
      for (const j of jobs) {
        out.push({
          title: j.title, company: j.companyName, url: j.applicationLink || j.guid,
          date: typeof j.pubDate === 'number' ? new Date(j.pubDate * 1000).toISOString() : j.pubDate,
          location: (j.locationRestrictions || []).join(', ') || 'Worldwide',
          type: j.employmentType || '', salary: yearly(j.minSalary, j.maxSalary, j.currency || j.salaryCurrency),
          tags: [...(j.categories || []), ...(j.parentCategories || [])], description: j.description || j.excerpt,
        });
      }
      if (!jobs.length) break;
    }
    return out;
  },

  async 'We Work Remotely'() {
    const feeds = ['remote-copywriting-jobs', 'remote-sales-and-marketing-jobs', 'remote-customer-support-jobs', 'all-other-remote-jobs'];
    const out = [];
    for (const f of feeds) {
      const xml = await get(`https://weworkremotely.com/categories/${f}.rss`, 'text');
      for (const it of rssItems(xml)) {
        const [company, ...rest] = it.title.split(': ');
        out.push({
          title: rest.length ? rest.join(': ') : it.title, company: rest.length ? company : '',
          url: it.link, date: it.pubDate, location: it.region, type: it.type,
          tags: [it.category], description: it.description,
        });
      }
    }
    return out;
  },

  async 'Working Nomads'() {
    const d = await get('https://www.workingnomads.com/api/exposed_jobs/');
    return d.map((j) => ({
      title: j.title, company: j.company_name, url: j.url, date: j.pub_date,
      location: j.location, type: '',
      tags: [j.category_name, ...(String(j.tags || '').split(','))], description: j.description,
    }));
  },
};

// ---------- Chạy ----------
async function main() {
  const now = Date.now();
  const sources = {};
  const seen = new Map();
  const rates = await getRates();

  let prev = {};
  if (PREV_URL) {
    try {
      const d = await get(PREV_URL);
      for (const j of d.jobs || []) if (j.vi) prev[j.id] = j.vi;
      console.log(`✓ Dùng lại ${Object.keys(prev).length} bản dịch cũ`);
    } catch (e) {
      console.warn(`- Chưa có bản dịch cũ (${e.message})`);
    }
  }

  for (const [name, fn] of Object.entries(SOURCES)) {
    try {
      const raw = await fn();
      let kept = 0;
      for (const j of raw) {
        if (!j.title || !j.url) continue;
        const ts = Date.parse(j.date);
        if (Number.isFinite(ts) && now - ts > MAX_AGE_DAYS * 864e5) continue;
        const tags = (j.tags || []).filter(Boolean).map(String);
        const cats = classify(`${j.title} ${tags.join(' ')}`);
        if (!cats.length) continue;
        const key = `${j.title}|${j.company}`.toLowerCase().replace(/[^a-z0-9|]/g, '');
        if (seen.has(key)) continue;
        const desc = strip(j.description || '');
        const text = `${j.title} ${tags.join(' ')} ${desc}`;
        const salary =
          buildSalary(j.salary, rates) ||
          buildSalary(parseSalary(j.salaryText), rates) ||
          buildSalary(parseSalary(desc), rates);
        seen.set(key, {
          id: key.slice(0, 80),
          title: strip(j.title),
          company: strip(j.company || ''),
          url: j.url,
          source: name,
          date: Number.isFinite(ts) ? new Date(ts).toISOString() : null,
          location: strip(j.location || '') || 'Không ghi',
          geoOpen: geoOpen(j.location),
          type: strip(j.type || '').replace(/_/g, ' '),
          flexible: FLEX.test(`${j.type} ${j.title}`),
          salaryText: strip(String(j.salaryText || '')),
          salary,
          categories: cats,
          vietnamese: /vietnam|việt/i.test(text),
          ...hints(desc),
          tags: [...new Set(tags.map((t) => t.toLowerCase()))].slice(0, 6),
          excerpt: cut(desc, 300),
          requirements: extractRequirements(j.description || ''),
        });
        kept++;
      }
      sources[name] = { ok: true, fetched: raw.length, kept };
      console.log(`✓ ${name}: ${raw.length} tin, giữ ${kept}`);
    } catch (e) {
      sources[name] = { ok: false, error: String(e.message || e) };
      console.warn(`✗ ${name}: ${e.message || e}`);
    }
  }

  const jobs = [...seen.values()].sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  // Dịch tiêu đề, tóm tắt và phần yêu cầu sang tiếng Việt.
  let translated = 0, reused = 0, failed = 0;
  for (const j of jobs) {
    if (prev[j.id]) { j.vi = prev[j.id]; reused++; continue; }
    if (translated >= MAX_NEW_TRANSLATIONS || failed >= 5) continue;
    try {
      // Dịch cả tiêu đề, tóm tắt, yêu cầu trong 1 lần gửi (mỗi phần 1 dòng).
      const parts = [j.title, j.excerpt || '-', ...j.requirements].map((t) => t.replace(/\n/g, ' '));
      let out = (await translate(parts.join('\n'))).split('\n').map((t) => t.trim());
      if (out.length !== parts.length) {
        // Hiếm khi số dòng lệch: dịch riêng từng phần.
        out = [];
        for (const t of parts) { out.push(await translate(t)); await sleep(800); }
      }
      j.vi = {
        title: out[0],
        summary: j.excerpt ? out[1] : '',
        requirements: out.slice(2).filter(Boolean),
      };
      translated++;
      await sleep(1200);
    } catch (e) {
      failed++;
      console.warn(`✗ Dịch "${j.title}": ${e.message}`);
    }
  }
  console.log(`Dịch mới ${translated}, dùng lại ${reused}, lỗi ${failed}`);

  await writeFile(
    OUT,
    JSON.stringify({ updatedAt: new Date().toISOString(), rates: { VND: Math.round(rates.VND), live: !!rates._live }, sources, jobs }, null, 1),
  );
  console.log(`Đã ghi ${jobs.length} việc vào ${OUT}`);
  if (!Object.values(sources).some((s) => s.ok)) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
