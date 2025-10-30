import express from "express";
import fetch from "node-fetch";
import unzipper from "unzipper";
import iconv from "iconv-lite";
import * as cheerio from "cheerio";

const app = express();
const PORT = process.env.PORT || 7000;
const ORIGINAL = "https://2ecbbd610840-podnapisi.baby-beamup.club";

// --- CORS ---
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Health
app.get("/", (req, res) => res.send("OK - subs-wrapper"));
app.get("/health", (req, res) => res.json({ ok: true }));

// Manifest (sprejmemo IMDb in TMDb)
app.get("/manifest.json", (req, res) => {
  res.json({
    id: "subs-wrapper",
    version: "1.1.0",
    name: "Podnapisi UTF-8 Wrapper",
    description: "ZIP/CP1250 → UTF-8 SRT (za ExoPlayer) + fallback iskanje",
    resources: ["subtitles"],
    types: ["movie", "series"],
    idPrefixes: ["tt", "tmdb"],
    catalogs: [],
    behaviorHints: { configurable: false, configurationRequired: false }
  });
});

// /srt: ZIP/.srt -> UTF-8 .srt
app.get("/srt", async (req, res) => {
  try {
    const zipUrl = req.query.zip;
    const charset = (req.query.charset || "cp1250").toLowerCase();
    const name = (req.query.name || "subtitles.srt").replace(/[^\w.\-()\[\] ]+/g, "_");
    if (!zipUrl) return res.status(400).send("Missing zip");

    const r = await fetch(zipUrl, {
      timeout: 25000,
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

// ---- helperji ----
async function fetchCinemetaTitle(type, id) {
  try {
    const url = `https://v3-cinemeta.strem.io/meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
    const r = await fetch(url, { timeout: 15000 });
    if (!r.ok) return null;
    const j = await r.json();
    const name = j?.meta?.name;
    const year = j?.meta?.year;
    return name && year ? `${name} ${year}` : (name || null);
  } catch { return null; }
}

async function searchPodnapisi(title, lang = "sl") {
  const q = encodeURIComponent(title);
  const url = `https://www.podnapisi.net/subtitles/search/?keywords=${q}&language=${lang}`;
  const r = await fetch(url, { timeout: 20000, headers: { "user-agent": "Mozilla/5.0" } });
  if (!r.ok) return [];
  const html = await r.text();
  const $ = cheerio.load(html);
  const links = [];
  $("a[href^='/subtitles/']").each((_, a) => {
    const href = $(a).attr("href") || "";
    if (/^\/subtitles\/\d+\//.test(href)) links.push("https://www.podnapisi.net" + href);
  });
  // unikati in prvi 3 rezultati
  return [...new Set(links)].slice(0, 3);
}

async function getZipFromDetail(detailUrl) {
  const r = await fetch(detailUrl, { timeout: 20000, headers: { "user-agent": "Mozilla/5.0" } });
  if (!r.ok) return null;
  const html = await r.text();
  const $ = cheerio.load(html);
  const a = $("a[href*='.zip'], a[href*='/download']").first();
  if (!a || !a.attr("href")) return null;
  const href = a.attr("href");
  return href.startsWith("http") ? href : "https://www.podnapisi.net" + href;
}

// skupni handler z fallback logiko
async function handleSubs(req, res) {
  try {
    const { type, id, extra } = req.params;
    const extraPart = extra ? `/${encodeURIComponent(extra)}` : "";
    const upstream = `${ORIGINAL}/subtitles/${encodeURIComponent(type)}/${encodeURIComponent(id)}${extraPart}.json`;

    // 1) poskusi original
    let items = [];
    try {
      const r = await fetch(upstream, {
        timeout: 25000,
        headers: { "user-agent": "Mozilla/5.0 (SubsWrapper)" }
      });
      if (r.ok) {
        const data = await r.json();
        if (Array.isArray(data?.subtitles)) items = data.subtitles;
      }
    } catch (_) {}

    // 2) če prazno -> fallback: Cinemeta title -> podnapisi.net search
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
            break; // vzemi prvi najdeni ZIP
          }
        }
      }
    }

    const base = `${req.protocol}://${req.get("host")}`;
    const subs = items.map((s, i) => {
      const orig = s.url || s.src || s.link || s.download || s.zip || s.href || s.file;
      const lang = s.lang || s.language || "Slovenian";
      const name = encodeURIComponent((s.title || lang || `subs_${i}`) + ".srt");
      if (!orig) return s;
      return {
        ...s,
        id: s.id || `${lang}_${i}`,
        lang,
        url: `${base}/srt?zip=${encodeURIComponent(orig)}&charset=cp1250&name=${name}`,
        format: "srt"
      };
    });

    res.json({ subtitles: subs });
  } catch (e) {
    console.error("Subtitles handler error:", e?.message || e);
    res.json({ subtitles: [] });
  }
}

// poti (brez/z :extra)
app.get("/subtitles/:type/:id.json", handleSubs);
app.get("/subtitles/:type/:id/:extra.json", handleSubs);

app.listen(PORT, () => console.log("Wrapper running on port", PORT));
