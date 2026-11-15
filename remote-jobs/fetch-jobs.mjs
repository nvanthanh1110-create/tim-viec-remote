#!/usr/bin/env node
// Lấy tin tuyển dụng remote từ các nguồn có API/RSS công khai, lọc theo
// 4 nhóm việc (SEO/Content, AI training, Dịch thuật, Trợ lý ảo/Marketing)
// rồi ghi ra remote-jobs/jobs.json cho trang index.html đọc.
// Chạy: node remote-jobs/fetch-jobs.mjs   (Node 18+, không cần cài thêm gì)

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'jobs.json');
const MAX_AGE_DAYS = 30;
const UA = 'Mozilla/5.0 (compatible; personal-remote-job-feed/1.0)';

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
export function geoOpen(loc) {
  const l = (loc || '').trim();
  return OPEN_GEO.test(l);
}

const FLEX = /(freelance|contract|part[- ]?time|hourly|temporary|flexible|gig|per task)/i;

// ---------- Tiện ích ----------
const strip = (html = '') =>
  html
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/\s+/g, ' ')
    .trim();

const excerpt = (s, n = 260) => {
  const t = strip(s);
  return t.length > n ? t.slice(0, n).replace(/\s\S*$/, '') + '…' : t;
};

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

const salaryText = (min, max, cur = 'USD', period = '') => {
  const f = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  if (!min && !max) return '';
  const range = min && max && min !== max ? `${f(min)}–${f(max)}` : f(min || max);
  return `${range} ${cur || 'USD'}${period ? '/' + period : ''}`;
};

// ---------- Nguồn ----------
// Mỗi hàm trả về mảng job thô: {title, company, url, date, location, type, salary, tags, description}

const SOURCES = {
  async Remotive() {
    const searches = ['seo', 'content writer', 'copywriter', 'translation', 'translator', 'vietnamese', 'virtual assistant', 'social media', 'ai trainer', 'annotation', 'data labeling'];
    const out = [];
    for (const q of searches) {
      const d = await get(`https://remotive.com/api/remote-jobs?search=${encodeURIComponent(q)}&limit=100`);
      for (const j of d.jobs || []) {
        out.push({
          title: j.title, company: j.company_name, url: j.url, date: j.publication_date,
          location: j.candidate_required_location, type: j.job_type, salary: j.salary || '',
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
      date: j.date, location: j.location, type: '', salary: salaryText(j.salary_min, j.salary_max, 'USD', 'năm'),
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
          salary: salaryText(j.annualSalaryMin, j.annualSalaryMax, j.salaryCurrency, 'năm'),
          tags: [...(Array.isArray(j.jobIndustry) ? j.jobIndustry : [j.jobIndustry || ''])],
          description: j.jobExcerpt || j.jobDescription,
        });
      }
    }
    if (!okCount) throw lastErr;
    return out;
  },

  async Himalayas() {
    const out = [];
    // API trả tối đa ~20 tin/trang: lật trang theo số tin thực nhận, tối đa 25 trang.
    for (let offset = 0, page = 0; page < 25; page++) {
      const d = await get(`https://himalayas.app/jobs/api?limit=20&offset=${offset}`);
      const jobs = d.jobs || [];
      offset += jobs.length;
      for (const j of jobs) {
        out.push({
          title: j.title, company: j.companyName, url: j.applicationLink || j.guid,
          date: typeof j.pubDate === 'number' ? new Date(j.pubDate * 1000).toISOString() : j.pubDate,
          location: (j.locationRestrictions || []).join(', ') || 'Worldwide',
          type: j.employmentType || '', salary: salaryText(j.minSalary, j.maxSalary, j.currency || j.salaryCurrency, 'năm'),
          tags: [...(j.categories || []), ...(j.parentCategories || [])], description: j.excerpt || j.description,
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
          url: it.link, date: it.pubDate, location: it.region, type: it.type, salary: '',
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
      location: j.location, type: '', salary: '',
      tags: [j.category_name, ...(String(j.tags || '').split(','))], description: j.description,
    }));
  },
};

// ---------- Chạy ----------
async function main() {
  const now = Date.now();
  const sources = {};
  const seen = new Map();

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
        const desc = strip(j.description || '');
        const key = `${j.title}|${j.company}`.toLowerCase().replace(/[^a-z0-9|]/g, '');
        if (seen.has(key)) continue;
        const text = `${j.title} ${tags.join(' ')} ${desc}`;
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
          salary: strip(String(j.salary || '')),
          categories: cats,
          vietnamese: /vietnam|việt/i.test(text),
          tags: [...new Set(tags.map((t) => t.toLowerCase()))].slice(0, 6),
          excerpt: excerpt(desc),
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
  await writeFile(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), sources, jobs }, null, 1));
  console.log(`Đã ghi ${jobs.length} việc vào ${OUT}`);
  if (!Object.values(sources).some((s) => s.ok)) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
