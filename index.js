// index.js — Subs UTF-8 Wrapper (diag: pokaži detailLinks, ZIP kandidat, cookie; +fixi)
import express from "express";
import fetch from "node-fetch";
import unzipper from "unzipper";
import iconv from "iconv-lite";
import * as cheerio from "cheerio";

const app = express();
const PORT = process.env.PORT || 7000;
const ORIGINAL = "https://2ecbbd610840-podnapisi.baby-beamup.club";

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Health / Manifest
app.get("/", (_req, res) => res.send("OK - subs-wrapper"));
app.get("/manifest.json", (_req, res) => {
  res.json({
    id: "subs-wrapper",
    version: "1.6.1",
    name: "Podnapisi UTF-8 Wrapper",
    description: "ZIP/CP1250 → UTF-8 .srt (ExoPlayer) + robust fallback (SL/EN) + DIAG",
    resources: ["subtitles"],
    types: ["movie", "series"],
    idPrefixes: ["tt", "tmdb"],
    catalogs: []
  });
});

// /srt z možnim Cookie + Referer
app.get("/srt", async (req, res) => {
  try {
    const zipUrl = String(req.query.zip || "");
    const charset = String(req.query.charset || "cp1250").toLowerCase();
    const cookie  = req.query.cookie ? String(req.query.cookie) : "";
    const referer = req.query.referer ? String(req.query.referer) : "https://www.podnapisi.net/";
    const name = (String(req.query.name || "subtitles.srt")).replace(/[^\w.\-()\[\] ]+/g, "_");
    if (!zipUrl) return res.status(400).send("Missing zip");

    const headers = {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      "accept": "*/*",
      "referer": referer
    };
    if (cookie) headers["cookie"] = cookie;

    const r = await fetch(zipUrl, { redirect: "follow", headers });
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
    console.error("SRT error:", e?.message || e);
    res.status(500).send("Subtitle processing error");
  }
});

// Helpers
function normTitle(t){ return (t||"").replace(/[:/|]+/g," ").replace(/\s+/g," ").trim(); }
async function fetchCinemeta(type,id){
  try{
    const url = `https://v3-cinemeta.strem.io/meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
    const r = await fetch(url, { headers: { "user-agent":"Mozilla/5.0" }});
    if(!r.ok) return null;
    const j = await r.json();
    return j?.meta || null;
  }catch{ return null; }
}
function buildQueriesFromMeta(meta){
  const out = new Set();
  if(!meta) return [...out];
  const title = normTitle(meta.name);
  const year  = meta.year ? String(meta.year) : "";
  if(title){ out.add(title); if(year) out.add(`${title} ${year}`); }
  const alts = []
    .concat(meta?.aka||[])
    .concat(meta?.alternateName||[])
    .concat(meta?.alternateTitles||[])
    .map(normTitle).filter(Boolean);
  for(const a of alts){ out.add(a); if(year) out.add(`${a} ${year}`); }
  return [...out];
}
async function searchPodnapisiOnce(query, lang="sl"){
  const url = `https://www.podnapisi.net/subtitles/search/?keywords=${encodeURIComponent(query)}&language=${lang}`;
  const r = await fetch(url, {
    redirect:"follow",
    headers:{
      "user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      "accept":"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language":"sl,en;q=0.9"
    }
  });
  if(!r.ok) return [];
  const html = await r.text();
  const $ = cheerio.load(html);
  const links = new Set();
  $("a[href^='/subtitles/']").each((_,a)=>{
    const href = $(a).attr("href")||"";
    if(/^\/subtitles\/\d+\//.test(href)) links.add("https://www.podnapisi.net"+href);
  });
  $("a[href*='/download']").each((_,a)=>{
    const href = $(a).attr("href")||"";
    if(!href) return;
    if(href.startsWith("http")) links.add(href);
    else if(href.startsWith("/")) links.add("https://www.podnapisi.net"+href);
  });
  return [...links];
}
function directDownloadCandidates(detailUrl){
  const m = detailUrl.match(/\/subtitles\/(\d+)\b/);
  if(!m) return [];
  const id = m[1];
  return [
    `https://www.podnapisi.net/subtitles/${id}/download?container=zip`,
    `https://www.podnapisi.net/subtitles/${id}/download`
  ];
}
function cookieFromSetCookie(sc){
  if(!sc) return "";
  // primitivni jar: vzemi prve cookie pare pred ;, loči z "; "
  return sc.split(",").map(s=>s.split(";")[0].trim()).filter(Boolean).join("; ");
}
async function readDetailAndGetZip(detailUrl){
  // preberi detail in poberi cookie
  const resp = await fetch(detailUrl, {
    redirect:"follow",
    headers:{
      "user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      "accept":"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "referer":"https://www.podnapisi.net/"
    }
  });
  if(!resp.ok) return { zipUrl:null, cookie:"", referer:detailUrl, detailUrl };
  const setCookie = resp.headers.get("set-cookie")||"";
  const cookie = cookieFromSetCookie(setCookie);
  const referer = detailUrl;

  const html = await resp.text();
  const $ = cheerio.load(html);
  let href = $("a[href*='.zip'], a[href*='/download']").first().attr("href");
  if(href){
    const full = href.startsWith("http") ? href : "https://www.podnapisi.net"+href;
    return { zipUrl:full, cookie, referer, detailUrl };
  }
  // poskusi direktne /download kandidate
  for(const u of directDownloadCandidates(detailUrl)){
    try{
      const head = await fetch(u,{ method:"HEAD", redirect:"manual", headers:{
        "user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "accept":"*/*","cookie":cookie,"referer":referer
      }});
      if([200,301,302].includes(head.status)) return { zipUrl:u, cookie, referer, detailUrl };
    }catch{}
  }
  return { zipUrl:null, cookie, referer, detailUrl };
}

// DIAG endpoint: ročno preveri naslov
app.get("/fallback-test", async (req,res)=>{
  const q = String(req.query.q||"");
  const lang = String(req.query.lang||"sl");
  const detailLinks = await searchPodnapisiOnce(q, lang);
  const diag = [];
  for(const d of detailLinks.slice(0,3)){
    const z = await readDetailAndGetZip(d);
    diag.push({ detail:d, zip:z.zipUrl, cookie: z.cookie ? "(captured)" : "", referer:z.referer });
  }
  res.json({ query:q, lang, detailLinks, diag });
});

// Glavni handler (NE enkodiramo :extra)
async function handleSubs(req,res){
  try{
    const type  = req.params.type;
    const id    = req.params.id;
    const extra = req.params.extra;
    const extraPart = extra ? `/${extra}` : "";
    const upstream = `${ORIGINAL}/subtitles/${encodeURIComponent(type)}/${encodeURIComponent(id)}${extraPart}.json`;

    let items = [];
    // 1) Dexter upstream
    try{
      const r = await fetch(upstream,{ headers:{ "user-agent":"Mozilla/5.0 (SubsWrapper)" }});
      if(r.ok){
        const data = await r.json();
        if(Array.isArray(data?.subtitles)) items = data.subtitles;
      } else {
        console.warn("Upstream status:", r.status);
      }
    }catch(e){ console.warn("Upstream error:", e?.message||e); }

    // 2) Fallback SL→EN
    if(!items.length){
      const meta = await fetchCinemeta(type,id);
      const queries = buildQueriesFromMeta(meta);
      let found = null, usedLang = "sl";
      outer: for(const lang of ["sl","en"]){
        for(const q of queries){
          console.log(`[FALLBACK ${lang}] search:`, q);
          const detailLinks = await searchPodnapisiOnce(q, lang);
          console.log(`[FALLBACK ${lang}] detail links:`, detailLinks.length);
          for(const d of detailLinks){
            const z = await readDetailAndGetZip(d);
            if(z.zipUrl){ found = { q, z, lang }; break outer; }
          }
        }
      }
      if(found){
        items.push({
          id: found.lang,
          lang: found.lang === "sl" ? "Slovenian" : "English",
          url: found.z.zipUrl,
          title: `Podnapisi.net (${found.lang.toUpperCase()}): ${found.q}`,
          _cookie: found.z.cookie || "",
          _referer: found.z.referer || "https://www.podnapisi.net/"
        });
      }
    }

    // 3) Normalizacija → /srt
    const base = `${req.protocol}://${req.get("host")}`;
    const subs = (items||[]).map((s,i)=>{
      const orig = s.url || s.src || s.link || s.download || s.zip || s.href || s.file;
      if(!orig) return null;
      const lang = s.lang || s.language || "Slovenian";
      const name = encodeURIComponent((s.title || lang || `subs_${i}`) + ".srt");
      const params = new URLSearchParams();
      params.set("zip", orig);
      params.set("charset","cp1250");
      params.set("name", name);
      if(s._cookie) params.set("cookie", s._cookie); // ne dvakrat enkodirati
      if(s._referer) params.set("referer", s._referer);
      return {
        ...s,
        id: s.id || `${lang}_${i}`,
        lang,
        url: `${base}/srt?${params.toString()}`,
        format: "srt"
      };
    }).filter(Boolean);

    res.json({ subtitles: subs });
  }catch(e){
    console.error("Handler error:", e?.message||e);
    res.json({ subtitles: [] });
  }
}

// Regex rute (Express 5)
app.get(/^\/subtitles\/([^/]+)\/([^/]+)\.json$/, (req,res)=>{ req.params.type=req.params[0]; req.params.id=req.params[1]; handleSubs(req,res); });
app.get(/^\/subtitles\/([^/]+)\/([^/]+)\/([^/]+)\.json$/, (req,res)=>{ req.params.type=req.params[0]; req.params.id=req.params[1]; req.params.extra=req.params[2]; handleSubs(req,res); });

app.listen(PORT, ()=>console.log("Wrapper running on port", PORT));
