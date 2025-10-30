import express from "express";
import fetch from "node-fetch";
import unzipper from "unzipper";
import iconv from "iconv-lite";

const app = express();
const PORT = process.env.PORT || 7000;
const ORIGINAL = "https://2ecbbd610840-podnapisi.baby-beamup.club";

// --- CORS: dovoli vse ---
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// --- Health / root (za hitri test & Render health check) ---
app.get("/", (req, res) => res.send("OK - subs-wrapper"));
app.get("/health", (req, res) => res.json({ ok: true }));

// --- Manifest ---
app.get("/manifest.json", (req, res) => {
  res.json({
    id: "subs-wrapper",
    version: "1.0.0",
    name: "Podnapisi UTF-8 Wrapper",
    description: "Pretvori ZIP/CP1250 → UTF-8 SRT (za ExoPlayer)",
    resources: ["subtitles"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs: [],
    behaviorHints: { configurable: false, configurationRequired: false }
  });
});

// --- /srt: ZIP/.srt -> UTF-8 .srt ---
app.get("/srt", async (req, res) => {
  try {
    const zipUrl = req.query.zip;
    const charset = (req.query.charset || "cp1250").toLowerCase();
    const name = (req.query.name || "subtitles.srt").replace(/[^\w.\-()\[\] ]+/g, "_");
    if (!zipUrl) return res.status(400).send("Missing zip");

    const r = await fetch(zipUrl, { timeout: 20000 });
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
    console.error("Subtitle error:", e);
    res.status(500).send("Subtitle processing error");
  }
});

// --- skupni handler ---
async function handleSubs(req, res) {
  try {
    const { type, id, extra } = req.params;
    const extraPart = extra ? `/${encodeURIComponent(extra)}` : "";
    const upstream = `${ORIGINAL}/subtitles/${encodeURIComponent(type)}/${encodeURIComponent(id)}${extraPart}.json`;

    const r = await fetch(upstream, { timeout: 20000 });
    if (!r.ok) throw new Error(`upstream ${r.status}`);
    const data = await r.json();

    const base = `${req.protocol}://${req.get("host")}`;
    const subs = (data.subtitles || []).map((s, i) => {
      const orig = s.url || s.src || s.link;
      if (!orig) return s;
      const name = encodeURIComponent((s.title || s.lang || `subs_${i}`) + ".srt");
      return {
        ...s,
        url: `${base}/srt?zip=${encodeURIComponent(orig)}&charset=cp1250&name=${name}`,
        format: "srt"
      };
    });

    res.json({ subtitles: subs });
  } catch (e) {
    console.error("Subtitles handler error:", e);
    res.json({ subtitles: [] });
  }
}

// dve poti (brez/z :extra)
app.get("/subtitles/:type/:id.json", handleSubs);
app.get("/subtitles/:type/:id/:extra.json", handleSubs);

app.listen(PORT, () => console.log("Wrapper running on port", PORT));
