// index.js — Podnapisi UTF-8 Wrapper (Render + CORS + fallback + regex routes + extra fix)
import express from "express";
import fetch from "node-fetch";
import unzipper from "unzipper";
import iconv from "iconv-lite";
import * as cheerio from "cheerio";

const app = express();
const PORT = process.env.PORT || 7000;

// ORIGINAL Dexterjev podnapisi addon (pusti ali zamenjaj po potrebi)
const ORIGINAL = "https://2ecbbd610840-podnapisi.baby-beamup.club";

// ---------- CORS ----------
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---------- Health / Root ----------
app.get("/", (_req, res) => res.send("OK - subs-wrapper"));
app.get("/health", (_req, res) => res.json({ ok: true }));

// ---------- Manifest ----------
app.get("/manifest.json", (_req, res) => {
  res.json({
    id: "subs-wrapper",
    version: "1.2.1",
    name: "Podnapisi UTF-8 Wrapper",
    description: "ZIP/CP1250 → UTF-8 .srt (ExoPlayer) + fallback iskanje",
    resources: ["subtitles"],
    types: ["movie", "series"],
    // sprejmemo IMDb in TMDb ID-je
    idPrefixes: ["tt", "tmdb"],
    catalogs: [],
    behaviorHints: { configurable: false, configurationRequired: false }
  });
});

// ---------- /srt: ZIP/.srt -> UTF-8 .srt ----------
app.get("/srt", async (req, res) => {
  try {
    const zipUrl = req.query.zip;
    const charset = (req.query.charset || "cp1250").toLowerCase();
    const name = (req.query.name || "subtitles.srt").replace(/[^\w.\-()\[\] ]+/g, "_");
    if (!zipUrl) return res.status(400).send("Missing zip");

    const r = await fetch(zipUrl, {
      // node-fetch v3 nima nativnega timeouta, a Render običajno prekine po ~2 min
      headers: { "user-agent": "Mozilla/5.0 (SubsWrapper)" }
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

// ---------- Helperji za fallback na podnapisi.net ----------
async function fetchCinemetaTitle(type, id) {
  try {
    const url = `https://v3-cinemeta.strem.io/meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
    const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
    if (!r.ok) return null;
    const j = await r.json();
    const name = j?.meta?.name;
    const year = j?.meta?.year;
    return name && year ? `${name} ${year}` : (name || null);
  } catch { return null; }
}

async function searchPodnapisi(title, lang = "sl") {
  try {
    const q = encodeURIComponent(title);
    const url = `https://www.podnapisi.net/subtitles/search/?keywords=${q}&language=${lang}`;
    const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
    if (!r.ok) return [];
    const html = await r.text();
    const $ = cheerio.load(html);
    const links = [];
    $("a[href^='/subtitles/']").each((_, a) => {
      const href = $(a).attr("href") || "";
      if (/^\/subtitles\/\d+\//.test(href)) links.push("https://www.podnapisi.net" + href);
    });
    return [...new Set(links)].slice(0, 3); // prvih par zadetkov
  } catch { return []; }
}

async function getZipFromDetail(detailUrl) {
  try {
    const r = await fetch(detailUrl, { headers: { "user-agent": "Mozilla/5.0" } });
    if (!r.ok) return null;
    const html = await r.text();
    const $ = cheerio.load(html);
    const a = $("a[href*='.zip'], a[href*='/download']").first();
    if (!a || !a.attr("href")) return null;
    const href = a.attr("href");
    return href.startsWith("http") ? href : "https://www.podnapisi.net" + href;
  } catch { return null; }
}

// ---------- DEBUG ----------
app.get("/debug/*", (req, res) => {
  res.json({
    method: req.method,
    path: req.path,
    params: req.params,
    query: req.query,
    note: "Primer: /debug/subtitles/series/tt0944947/1:1.json"
  });
});

// ---------- Skupni handler (NE enkodiramo :extra!) ----------
async function handleSubs(req, res) {
  try {
    const type  = req.params.type;        // 'movie' | 'series'
    const id    = req.params.id;          // 'tt1375666' ali 'tmdb:12345'
    const extra = req.params.extra;       // npr. '1:1' — pusti dvopičje

    const extraPart = extra ? `/${extra}` : ""; // BREZ encodeURIComponent na extra
    const upstream = `${ORIGINAL}/subtitles/${encodeURIComponent(type)}/${encodeURIComponent(id)}${extraPart}.json`;

    // 1) originalni Dexterjev addon
    let items = [];
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

    // 2) Fallback: če ni nič, poišči po naslovu na podnapisi.net
    if (!items.length) {
      const title = await fetchCinemetaTitle(type, id);
      if (title) {
        const detailPages = await searchPodnapisi(title, "sl");
        for (const detail of detailPages) {
          const zip = await getZipFromDetail(detail);
          if (zip) {
            items.push({
              id: "sl",
              lang: "Slovenian",
              url: zip,
              title: `Podnapisi: ${title}`
            });
            break;
          }
        }
      }
    }

    // 3) Normaliziraj rezultat in preusmeri skozi /srt (UTF-8 + HTTPS)
    const base = `${req.protocol}://${req.get("host")}`;
    const subs = items
      .map((s, i) => {
        const orig =
          s.url || s.src || s.link || s.download || s.zip || s.href || s.file;
        const lang = s.lang || s.language || "Slovenian";
        const name = encodeURIComponent((s.title || lang || `subs_${i}`) + ".srt");
        if (!orig) return null;
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
    console.error("Subtitles handler error:", e?.message || e);
    res.json({ subtitles: [] });
  }
}

// ---------- POPRAVLJENE RUTE (Regex, združljivo z Express 5) ----------
// brez :extra  (npr. /subtitles/movie/tt1375666.json)
app.get(/^\/subtitles\/([^/]+)\/([^/]+)\.json$/, (req, res) => {
  req.params.type = req.params[0];
  req.params.id   = req.params[1];
  handleSubs(req, res);
});

// z :extra (npr. /subtitles/series/tt0944947/1:1.json ali /subtitles/series/tmdb:123/1:1.json)
app.get(/^\/subtitles\/([^/]+)\/([^/]+)\/([^/]+)\.json$/, (req, res) => {
  req.params.type  = req.params[0];
  req.params.id    = req.params[1];
  req.params.extra = req.params[2];
  handleSubs(req, res);
});

// ---------- Start ----------
app.listen(PORT, () => console.log("Wrapper running on port", PORT));
