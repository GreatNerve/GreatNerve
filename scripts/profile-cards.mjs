import { writeFile } from "node:fs/promises";

const LOGIN = process.env.PROFILE_LOGIN ?? "GreatNerve";
const TOKEN = process.env.GITHUB_TOKEN;
const OUT = new URL("../assets/activity.svg", import.meta.url);
const EXCLUDED_LANGUAGES = new Set(["HTML", "CSS"]);
const LANGUAGE_COUNT = 6;
const RECENT_DAYS = 30;
const DEVICON = "https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons";
const DEVICON_SLUGS = {
  TypeScript: "typescript", JavaScript: "javascript", Python: "python", Java: "java",
  "C++": "cplusplus", C: "c", "C#": "csharp", Go: "go", Rust: "rust", Kotlin: "kotlin",
  PHP: "php", Ruby: "ruby", Shell: "bash", PowerShell: "powershell", Dart: "dart",
  Swift: "swift", "Jupyter Notebook": "jupyter", Dockerfile: "docker", Vue: "vuejs",
};
const DARK_FILLS = { bash: ["#293138"] };

const MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif";
const C = { bg: "#0d1117", border: "#30363d", accent: "#58a6ff", text: "#c9d1d9", bright: "#e6edf3", muted: "#7d8590" };

if (!TOKEN) {
  console.error("GITHUB_TOKEN is required");
  process.exit(1);
}

async function gql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${TOKEN}`, "Content-Type": "application/json", "User-Agent": "profile-cards" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(JSON.stringify(json.errors ?? json));
  return json.data;
}

async function topLanguages() {
  const query = `query($login: String!, $after: String) {
    user(login: $login) {
      repositories(first: 100, after: $after, ownerAffiliations: OWNER, isFork: false, privacy: PUBLIC) {
        pageInfo { hasNextPage endCursor }
        nodes { languages(first: 20, orderBy: { field: SIZE, direction: DESC }) { edges { size node { name color } } } }
      }
    }
  }`;
  const totals = new Map();
  let after = null;
  do {
    const { repositories } = (await gql(query, { login: LOGIN, after })).user;
    for (const repo of repositories.nodes) {
      for (const { size, node } of repo.languages.edges) {
        if (EXCLUDED_LANGUAGES.has(node.name)) continue;
        const entry = totals.get(node.name) ?? { name: node.name, color: node.color ?? C.muted, size: 0 };
        entry.size += size;
        totals.set(node.name, entry);
      }
    }
    after = repositories.pageInfo.hasNextPage ? repositories.pageInfo.endCursor : null;
  } while (after);

  const sum = [...totals.values()].reduce((acc, l) => acc + l.size, 0);
  return [...totals.values()]
    .sort((a, b) => b.size - a.size)
    .slice(0, LANGUAGE_COUNT)
    .map((l) => ({ ...l, percent: (l.size / sum) * 100 }));
}

async function contributionDays() {
  const { user } = await gql(`query($login: String!) { user(login: $login) { createdAt } }`, { login: LOGIN });
  const query = `query($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        contributionCalendar { weeks { contributionDays { date contributionCount } } }
      }
    }
  }`;
  const now = new Date();
  const created = new Date(user.createdAt);
  const days = new Map();
  for (let year = created.getUTCFullYear(); year <= now.getUTCFullYear(); year++) {
    const from = new Date(Math.max(created, Date.UTC(year, 0, 1)));
    const to = new Date(Math.min(now, Date.UTC(year, 11, 31, 23, 59, 59)));
    const data = await gql(query, { login: LOGIN, from: from.toISOString(), to: to.toISOString() });
    for (const week of data.user.contributionsCollection.contributionCalendar.weeks) {
      for (const day of week.contributionDays) days.set(day.date, day.contributionCount);
    }
  }
  const today = now.toISOString().slice(0, 10);
  return {
    since: created.getUTCFullYear(),
    days: [...days.entries()]
      .filter(([date]) => date <= today)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({ date, count })),
  };
}

function streaks(days) {
  const total = days.reduce((acc, d) => acc + d.count, 0);

  let longest = { length: 0, start: null, end: null };
  let run = { length: 0, start: null };
  for (const day of days) {
    if (day.count > 0) {
      if (run.length === 0) run.start = day.date;
      run.length += 1;
      if (run.length > longest.length) longest = { length: run.length, start: run.start, end: day.date };
    } else {
      run = { length: 0, start: null };
    }
  }

  let i = days.length - 1;
  if (i >= 0 && days[i].count === 0) i -= 1;
  const end = i >= 0 ? days[i].date : null;
  let length = 0;
  while (i >= 0 && days[i].count > 0) {
    length += 1;
    i -= 1;
  }
  const current = { length, start: length ? days[i + 1].date : null, end: length ? end : null };

  return { total, longest, current };
}

const shortDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const fullDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const number = new Intl.NumberFormat("en-US");

function range(start, end, withYear) {
  if (!start) return "no active streak";
  const fmt = withYear ? fullDate : shortDate;
  const a = new Date(`${start}T00:00:00Z`);
  const b = new Date(`${end}T00:00:00Z`);
  if (start === end) return fmt.format(a);
  return `${shortDate.format(a)} - ${fmt.format(b)}`;
}

async function languageIcon(name) {
  const slug = DEVICON_SLUGS[name];
  if (!slug) return null;
  const res = await fetch(`${DEVICON}/${slug}/${slug}-original.svg`);
  if (!res.ok) return null;
  let body = (await res.text()).match(/<svg[^>]*>([\s\S]*)<\/svg>/)?.[1];
  if (!body) return null;
  const ids = [...new Set([...body.matchAll(/id="([^"]+)"/g)].map((m) => m[1]))].sort((a, b) => b.length - a.length);
  for (const id of ids) {
    const next = `lang-${slug}-${id}`;
    body = body
      .replaceAll(`id="${id}"`, `id="${next}"`)
      .replaceAll(`url(#${id})`, `url(#${next})`)
      .replaceAll(`href="#${id}"`, `href="#${next}"`);
  }
  for (const dark of DARK_FILLS[slug] ?? []) body = body.replaceAll(`fill="${dark}"`, `fill="${C.text}"`);
  return body;
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function render(languages, { since, days }) {
  const { total, longest, current } = streaks(days);
  const parts = [];

  parts.push(`<text x="64" y="40" font-family="${MONO}" font-size="12" fill="${C.muted}">top languages</text>`);
  const top = languages[0]?.percent ?? 1;
  languages.forEach((lang, i) => {
    const y = 78 + i * 28;
    const width = Math.max(3, (180 * lang.percent) / top);
    parts.push(`<rect x="64.5" y="${y - 17.5}" width="25" height="25" rx="6" fill="#161b22" stroke="${C.border}"/>`);
    if (lang.icon) {
      parts.push(`<svg x="68" y="${y - 14}" width="18" height="18" viewBox="0 0 128 128">${lang.icon}</svg>`);
    }
    parts.push(`<text x="102" y="${y}" font-family="${MONO}" font-size="12" fill="${C.text}">${esc(lang.name)}</text>`);
    parts.push(`<rect x="204" y="${y - 8}" width="${width.toFixed(1)}" height="6" rx="3" fill="${lang.color}"/>`);
    parts.push(`<text x="436" y="${y}" text-anchor="end" font-family="${MONO}" font-size="12" fill="${C.muted}">${lang.percent.toFixed(1)}%</text>`);
  });

  parts.push(`<text x="564" y="40" font-family="${MONO}" font-size="12" fill="${C.muted}">contribution streak</text>`);
  const stats = [
    { x: 564, value: number.format(total), label: "contributions", sub: `since ${since}`, color: C.bright },
    { x: 688, value: current.length, label: "current streak", sub: range(current.start, current.end, false), color: C.accent },
    { x: 812, value: longest.length, label: "longest streak", sub: range(longest.start, longest.end, true), color: C.bright },
  ];
  for (const s of stats) {
    parts.push(`<text x="${s.x}" y="94" font-family="${SANS}" font-size="30" font-weight="700" fill="${s.color}">${esc(s.value)}</text>`);
    parts.push(`<text x="${s.x}" y="116" font-family="${MONO}" font-size="12" fill="${C.text}">${s.label}</text>`);
    parts.push(`<text x="${s.x}" y="134" font-family="${MONO}" font-size="11" fill="${C.muted}">${esc(s.sub)}</text>`);
  }

  const recent = days.slice(-RECENT_DAYS);
  const peak = Math.max(1, ...recent.map((d) => d.count));
  parts.push(`<text x="564" y="170" font-family="${MONO}" font-size="11" fill="${C.muted}">last ${RECENT_DAYS} days</text>`);
  recent.forEach((day, i) => {
    const x = 564 + i * 12.4;
    if (day.count === 0) {
      parts.push(`<rect x="${x.toFixed(1)}" y="212" width="9" height="2" rx="1" fill="${C.border}"/>`);
      return;
    }
    const h = Math.max(4, (34 * day.count) / peak);
    const opacity = (0.35 + (0.65 * day.count) / peak).toFixed(2);
    parts.push(`<rect x="${x.toFixed(1)}" y="${(214 - h).toFixed(1)}" width="9" height="${h.toFixed(1)}" rx="2" fill="${C.accent}" fill-opacity="${opacity}"/>`);
  });

  const summary = `Top languages: ${languages.map((l) => `${l.name} ${l.percent.toFixed(1)}%`).join(", ")}. ${number.format(total)} contributions since ${since}, current streak ${current.length} days, longest streak ${longest.length} days.`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="250" viewBox="0 0 1000 250" role="img" aria-labelledby="title">
  <title id="title">${esc(summary)}</title>
  <rect x="0.5" y="0.5" width="999" height="249" rx="14" fill="${C.bg}" stroke="${C.border}"/>
  <path d="M500 32 V218" stroke="${C.border}"/>
  ${parts.join("\n  ")}
</svg>
`;
}

const [ranked, calendar] = await Promise.all([topLanguages(), contributionDays()]);
const languages = await Promise.all(ranked.map(async (lang) => ({ ...lang, icon: await languageIcon(lang.name) })));
await writeFile(OUT, render(languages, calendar));
console.log(`wrote ${OUT.pathname}`);
