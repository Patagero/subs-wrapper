// index.js — Podnapisi UTF-8 Wrapper (Render + Podnapisi.net iskanje po naslovu)
import express from "express";
import fetch from "node-fetch";
import unzipper from "unzipper";
import iconv from "iconv-lite";
import * as cheerio from "cheerio";

const app = express();
const PORT = process.env.PORT || 7000;
const ORIGINAL = "https://2ecbbd610840-podnapisi.baby-beamup.club";

// ---------- CORS ----------
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---------- Manifest ----------
app.get("/manifest.json", (_req, res) => {
  res.json({
    id: "subs-wrapper",
    version: "1.3.0",
    name: "Podnapisi UTF-8 Wrapper",
    description: "ZIP/CP1250 → UTF-8 .srt (ExoPlayer) + Podnapisi.net fallback",
    resources: ["subtitles"],
    types: ["movie", "series"],
    idPrefixes: ["tt", "tmdb"],
    catalogs: [],
  });
});

// ---------- Pretvorba ZIP/.SRT ----------
app.get("/srt", async (req, res) => {
  try {
    const zipUrl = req.query.zip;
    const charset = (req.query.charset || "cp1250").toLowerCase();
    const name = (req.query.name || "subtitles.srt").replace(/[^\w.\-()\[\] ]+/g, "_");

    if (!zipUrl) return res.status(400).send("Missing zip");
    const r = await fetch(zipUrl, { headers: { "user-agent": "Mozilla/5.0" } });
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
    console.error("Subtitle error:", e.message);
    res.status(500).send("Subtitle processing error");
  }
});

// ---------- Pomožne funkcije ----------
async function fetchCinemetaTitle(type, id) {
  try {
    const url = `https://v3-cinemeta.strem.io/meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
    const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
    if (!r.ok) return null;
    const j = await r.json();
    const name = j?.meta?.name;
    const year = j?.meta?.year;
    return name && year ? `${name} ${year}` : (name || null);
  } catch {
    return null;
  }
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
      const href = $(a).attr("href");
      if (href && /^\/subtitles\/\d+\//.test(href))
        links.push("https://www.podnapisi.net" + href);
    });
    return [...new Set(links)].slice(0, 5);
  } catch {
    return [];
  }
}

async function getZipFromDetail(detailUrl) {
  try {
    const r = await fetch(detailUrl, { headers: { "user-agent": "Mozilla/5.0" } });
    if (!r.ok) return null;
    const html = await r.text();
    const $ = cheerio.load(html);
    const a = $("a[href*='.zip'], a[href*='/download']").first();
    const href = a?.attr("href");
    if (!href) return null;
    return href.startsWith("http") ? href : "https://www.podnapisi.net" + href;
  } catch {
    return null;
  }
}

// ---------- Glavni handler ----------
async function handleSubs(req, res) {
  try {
    const type = req.params.type;
    const id = req.params.id;
    const extra = req.params.extra;
    const extraPart = extra ? `/${extra}` : "";
    const upstream = `${ORIGINAL}/subtitles/${encodeURIComponent(type)}/${encodeURIComponent(id)}${extraPart}.json`;

    let items = [];

    // 1️⃣ Poizkus originalnega Dextera
    try {
      const r = await fetch(upstream, { headers: { "user-agent": "Mozilla/5.0" } });
      if (r.ok) {
        const data = await r.json();
        if (Array.isArray(data?.subtitles)) items = data.subtitles;
      }
    } catch (e) {
      console.warn("Upstream fail:", e.message);
    }

    // 2️⃣ Če nič — poišči po naslovu na Podnapisi.net
    if (!items.length) {
      const title = await fetchCinemetaTitle(type, id);
      if (title) {
        console.log("Searching fallback:", title);
        const detailPages = await searchPodnapisi(title, "sl");
        for (const detail of detailPages) {
          const zip = await getZipFromDetail(detail);
          if (zip) {
            items.push({
              id: "sl",
              lang: "Slovenian",
              url: zip,
              title: `Podnapisi.net: ${title}`
            });
            break;
          }
        }
      }
    }

    // 3️⃣ Pretvori v UTF-8 linke
    const base = `${req.protocol}://${req.get("host")}`;
    const subs = items.map((s, i) => {
      const orig = s.url || s.link || s.src;
      const name = encodeURIComponent((s.title || "subs") + ".srt");
      return {
        id: s.id || `${s.lang}_${i}`,
        lang: s.lang || "Slovenian",
        url: `${base}/srt?zip=${encodeURIComponent(orig)}&charset=cp1250&name=${name}`,
        format: "srt",
        title: s.title
      };
    });

    res.json({ subtitles: subs });
  } catch (e) {
    console.error("Handler error:", e.message);
    res.json({ subtitles: [] });
  }
}

// ---------- Regex ruti ----------
app.get(/^\/subtitles\/([^/]+)\/([^/]+)\.json$/, (req, res) => {
  req.params.type = req.params[0];
  req.params.id = req.params[1];
  handleSubs(req, res);
});

app.get(/^\/subtitles\/([^/]+)\/([^/]+)\/([^/]+)\.json$/, (req, res) => {
  req.params.type = req.params[0];
  req.params.id = req.params[1];
  req.params.extra = req.params[2];
  handleSubs(req, res);
});

// ---------- Start ----------
app.listen(PORT, () => console.log("Wrapper running on port", PORT));
