// index.js — Subs UTF-8 Wrapper (Render + robust Podnapisi download + SL/EN fallback + regex routes)
import express from "express";
import fetch from "node-fetch";
import unzipper from "unzipper";
import iconv from "iconv-lite";
import * as cheerio from "cheerio";

const app = express();
const PORT = process.env.PORT || 7000;
const ORIGINAL = "https://2ecbbd610840-podnapisi.baby-beamup.club";

// ---- CORS ----
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---- Health / Manifest ----
app.get("/", (_req, res) => res.send("OK - subs-wrapper"));
app.get("/manifest.json", (_req, res) => {
  res.json({
    id: "subs-wrapper",
    version: "1.5.0",
    name: "Podnapisi UTF-8 Wrapper",
    description: "ZIP/CP1250 → UTF-8 .srt (ExoPlayer) + robust fallback (SL/EN)",
    resources: ["subtitles"],
    types: ["movie", "series"],
    idPrefixes: ["tt", "tmdb"],
    catalogs: [],
    behaviorHints: { configurable: false, configurationRequired: false }
  });
});

// ---- ZIP/.SRT → UTF-8 .srt ----
app.get("/srt", async (req, res) => {
  try {
    const zipUrl = req.query.zip;
    const charset = (req.query.charset || "cp1250").toLowerCase();
    const name = (req.query.name || "subtitles.srt").replace(/[^\w.\-()\[\] ]+/g, "_");
    if (!zipUrl) return res.status(400).send("Missing zip");

    const r = await fetch(zipUrl, {
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "accept": "*/*",
        "referer": "https://www.podnapisi.net/"
      }
    });
    if (!r.ok) throw new Error(`fetch ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());

    let srt;
    if (/\.zip(\?.*)?$/i.test(zipUrl)) {
      const dir = await unzipper.Open.buffer(buf);
      const entry = dir.files.find(f => /\.(srt|ass|sub)$/i.test(f.path));
      if (!entry) throw new Error("No subtitle in ZIP");
      const raw = await entry.buffer();
      srt = Buffer.from(iconv.decode(raw, charset), "utf8");
    } else {
      srt = Buffer.from(iconv.decode(buf, charset), "utf8");
    }

    res.setHeader("Content-Type", "application/x-subrip; charset=utf-8");
    res.setHeader("Content-Disposition", `inline; filename="${name}"`);
    res.status(200).send(srt);
  } catch (e) {
    console.error("Subtitle error:", e?.message || e);
    res.status(500).send("Subtitle processing error");
  }
});

// ---- helpers: Cinemeta + Podnapisi ----
function normTitle(t) {
  return (t || "").replace(/[:/|]+/g, " ").replace(/\s+/g, " ").trim();
}
async function fetchCinemeta(type, id) {
  try {
    const url = `https://v3-cinemeta.strem.io/meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
    const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.meta || null;
  } catch { return null; }
}
function buildQueriesFromMeta(meta) {
  const out = new Set();
  if (!meta) return [...out];
  const title = normTitle(meta.name);
  const year = meta.year ? String(meta.year) : "";
  if (title) {
    out.add(title);
    if (year) out.add(`${title} ${year}`);
  }
  const alts = []
    .concat(meta?.aka || [])
    .concat(meta?.alternateName || [])
    .concat(meta?.alternateTitles || [])
    .map(normTitle)
    .filter(Boolean);
  for (const a of alts) {
    out.add(a);
    if (year) out.add(`${a} ${year}`);
  }
  return [...out];
}
async function searchPodnapisiOnce(query, lang = "sl") {
  const q = encodeURIComponent(query);
  const url = `https://www.podnapisi.net/subtitles/search/?keywords=${q}&language=${lang}`;
  const r = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "sl,en;q=0.9"
    }
  });
  if (!r.ok) return [];
  const html = await r.text();
  const $ = cheerio.load(html);
  const links = new Set();
  $("a[href^='/subtitles/']").each((_, a) => {
    const href = $(a).attr("href") || "";
    if (/^\/subtitles\/\d+\//.test(href)) links.add("https://www.podnapisi.net" + href);
  });
  $("a[href*='/download']").each((_, a) => {
    const href = $(a).attr("href") || "";
    if (!href) return;
    if (href.startsWith("http")) links.add(href);
    else if (href.startsWith("/")) links.add("https://www.podnapisi.net" + href);
  });
  return [...links];
}

function buildDirectDownload(detailUrl) {
  // Če je detail URL oblike /subtitles/123456/nekaj → naredimo /subtitles/123456/download
  const m = detailUrl.match(/\/subtitles\/(\d+)\b/);
  if (!m) return null;
  const id = m[1];
  return [
    `https://www.podnapisi.net/subtitles/${id}/download?container=zip`,
    `https://www.podnapisi.net/subtitles/${id}/download`
  ];
}

async function firstZip(detailUrl) {
  // 1) Poskusi direktne /download URL-je iz ID-ja
  const direct = buildDirectDownload(detailUrl) || [];
  for (const d of direct) {
    try {
      const rd = await fetch(d, {
        redirect: "follow",
        headers: {
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
          "accept": "*/*",
          "referer": detailUrl
        }
      });
      if (rd.ok) {
        const finalUrl = rd.url; // po redirectu
        if (/\.zip(\?.*)?$/i.test(finalUrl)) return finalUrl;
        // včasih vrača zip vsebino brez .zip v URL-ju — vseeno vrnemo d
        const ct = rd.headers.get("content-type") || "";
        if (/zip|octet-stream/i.test(ct)) return d;
      }
    } catch (_) {}
  }

  // 2) Če direktni ne delajo, preberi detail HTML in najdi linke
  try {
    const r = await fetch(detailUrl, {
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "referer": "https://www.podnapisi.net/"
      }
    });
    if (!r.ok) return null;
    const html = await r.text();
    const $ = cheerio.load(html);
    // prioritetno poglej .zip in /download
    const a = $("a[href*='.zip'], a[href*='/download']").first();
    const href = a?.attr("href");
    if (href) {
      const full = href.startsWith("http") ? href : "https://www.podnapisi.net" + href;
      if (full) return full;
    }
  } catch (_) {}

  return null;
}

// ---- DEBUG ----
app.get("/debug/*", (req, res) => {
  res.json({ method: req.method, path: req.path, params: req.params, query: req.query });
});

// ---- Handler (NE enkodiramo :extra) ----
async function handleSubs(req, res) {
  try {
    const type  = req.params.type;
    const id    = req.params.id;
    const extra = req.params.extra;
    const extraPart = extra ? `/${extra}` : "";
    const upstream = `${ORIGINAL}/subtitles/${encodeURIComponent(type)}/${encodeURIComponent(id)}${extraPart}.json`;

    let items = [];

    // 1) Dexter upstream
    try {
      const r = await fetch(upstream, { headers: { "user-agent": "Mozilla/5.0 (SubsWrapper)" } });
      if (r.ok) {
        const data = await r.json();
        if (Array.isArray(data?.subtitles)) items = data.subtitles;
      } else {
        console.warn("Upstream status:", r.status);
      }
    } catch (e) {
      console.warn("Upstream error:", e?.message || e);
    }

    // 2) Fallback na Podnapisi — najprej SL, potem EN
    if (!items.length) {
      const meta = await fetchCinemeta(type, id);
      const queries = buildQueriesFromMeta(meta);
      // Najprej slovenščina, nato angleščina
      for (const lang of ["sl", "en"]) {
        for (const q of queries) {
          console.log(`[FALLBACK ${lang}] search:`, q);
          const detailLinks = await searchPodnapisiOnce(q, lang);
          console.log(`[FALLBACK ${lang}] detail links:`, detailLinks.length);
          for (const d of detailLinks) {
            const zip = await firstZip(d);
            if (zip) {
              items.push({
                id: lang,
                lang: lang === "sl" ? "Slovenian" : "English",
                url: zip,
                title: `Podnapisi.net (${lang.toUpperCase()}): ${q}`
              });
              break;
            }
          }
          if (items.length) break;
        }
        if (items.length) break;
      }
    }

    // 3) Normalizacija → /srt
    const base = `${req.protocol}://${req.get("host")}`;
    const subs = (items || [])
      .map((s, i) => {
        const orig = s.url || s.src || s.link || s.download || s.zip || s.href || s.file;
        if (!orig) return null;
        const lang = s.lang || s.language || "Slovenian";
        const name = encodeURIComponent((s.title || lang || `subs_${i}`) + ".srt");
        return {
          ...s,
          id: s.id || `${lang}_${i}`,
          lang,
          url: `${base}/srt?zip=${encodeURIComponent(orig)}&charset=cp1250&name=${name}`,
          format: "srt"
        };
      })
      .filter(Boolean);

    res.json({ subtitles: subs });
  } catch (e) {
    console.error("Handler error:", e?.message || e);
    res.json({ subtitles: [] });
  }
}

// ---- Regex rute (Express 5) ----
app.get(/^\/subtitles\/([^/]+)\/([^/]+)\.json$/, (req, res) => {
  req.params.type = req.params[0];
  req.params.id   = req.params[1];
  handleSubs(req, res);
});
app.get(/^\/subtitles\/([^/]+)\/([^/]+)\/([^/]+)\.json$/, (req, res) => {
  req.params.type  = req.params[0];
  req.params.id    = req.params[1];
  req.params.extra = req.params[2];
  handleSubs(req, res);
});

app.listen(PORT, () => console.log("Wrapper running on port", PORT));
