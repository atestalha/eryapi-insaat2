/* ============================================================
   ER Yapı İnşaat — Web sitesi + Yönetim Paneli sunucusu
   Bilgisayarda:  BASLAT.bat (veya npm start) → içerik diske kaydedilir
   Vercel'de:     İçerik Upstash Redis'e, fotoğraf/videolar Vercel Blob'a kaydedilir
                  (BENIOKU.txt → "Vercel'e yükleme")
   Site:  /        Panel: /admin
   ============================================================ */
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const SEED = require("./data/varsayilan.json");

const PORT = process.env.PORT || 3000;
const ON_VERCEL = !!process.env.VERCEL;
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const AUTH_FILE = path.join(DATA_DIR, "admin.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const UPLOAD_DIR = path.join(PUBLIC_DIR, "uploads");
const DEFAULT_PASSWORD = process.env.ADMIN_SIFRE || "eryapi2026";

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const USE_REDIS = !!(REDIS_URL && REDIS_TOKEN);
const USE_BLOB = !!process.env.BLOB_READ_WRITE_TOKEN;

/* ---------------- Depolama ----------------
   Redis varsa: içerik ve şifre Redis'te.
   Yoksa: data/db.json ve data/admin.json dosyaları (yerel bilgisayar).
   İkisi de yoksa (Vercel'de bağlantı kurulmamışsa): varsayılan içerik, değişiklik kalıcı olmaz. */
const clone = (o) => JSON.parse(JSON.stringify(o));
let redis = null;
if (USE_REDIS) {
  const { Redis } = require("@upstash/redis");
  redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
}
const K_DB = "eryapi:db", K_AUTH = "eryapi:auth";
let memDb = null, memAuth = null;
let fileOk = !ON_VERCEL;

async function loadDb() {
  if (redis) {
    let d = await redis.get(K_DB);
    if (!d) { d = clone(SEED); await redis.set(K_DB, d); }
    return d;
  }
  if (fileOk) {
    try {
      if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify(SEED, null, 2));
      return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    } catch (e) { fileOk = false; console.log("Dosyaya erişilemiyor, geçici bellek kullanılacak:", e.message); }
  }
  return memDb || (memDb = clone(SEED));
}
async function saveDb(d) {
  if (redis) return redis.set(K_DB, d);
  if (fileOk) {
    try { const tmp = DB_FILE + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(d, null, 2)); fs.renameSync(tmp, DB_FILE); return; }
    catch (e) { fileOk = false; console.log("Kayıt dosyaya yazılamadı:", e.message); }
  }
  memDb = d;
}
function hashPassword(pw, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString("hex") };
}
const newAuth = (pw) => ({ ...hashPassword(pw), secret: crypto.randomBytes(32).toString("hex") });
async function loadAuth() {
  if (redis) {
    let a = await redis.get(K_AUTH);
    if (!a) { a = newAuth(DEFAULT_PASSWORD); await redis.set(K_AUTH, a); }
    return a;
  }
  if (fileOk) {
    try {
      if (!fs.existsSync(AUTH_FILE)) fs.writeFileSync(AUTH_FILE, JSON.stringify(newAuth(DEFAULT_PASSWORD), null, 2));
      return JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
    } catch (e) { fileOk = false; }
  }
  if (!memAuth) {
    // Kalıcı depolama yoksa oturum anahtarı sabit olsun ki her sunucu örneğinde geçerli kalsın
    const secret = crypto.createHash("sha256").update("eryapi:" + DEFAULT_PASSWORD).digest("hex");
    memAuth = { ...hashPassword(DEFAULT_PASSWORD, secret.slice(0, 32)), secret };
  }
  return memAuth;
}
async function saveAuth(a) {
  if (redis) return redis.set(K_AUTH, a);
  if (fileOk) { try { fs.writeFileSync(AUTH_FILE, JSON.stringify(a, null, 2)); return; } catch (e) { fileOk = false; } }
  memAuth = a;
}
const storageInfo = () => ({
  icerik: redis ? "redis" : fileOk ? "dosya" : "gecici",
  dosyalar: USE_BLOB ? "blob" : process.env.BLOB_STORE_ID ? "token-yok" : ON_VERCEL ? "yok" : "dosya",
});

/* ---------------- Oturum ---------------- */
const SESSION_HOURS = 12;
function checkPassword(auth, pw) {
  const h = crypto.scryptSync(String(pw || ""), auth.salt, 64);
  return crypto.timingSafeEqual(h, Buffer.from(auth.hash, "hex"));
}
function makeToken(auth) {
  const exp = Date.now() + SESSION_HOURS * 3600e3;
  return exp + "." + crypto.createHmac("sha256", auth.secret).update(String(exp)).digest("hex");
}
function validToken(auth, t) {
  if (!t) return false;
  const [exp, sig] = String(t).split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const good = crypto.createHmac("sha256", auth.secret).update(exp).digest("hex");
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}
function getCookie(req, name) {
  const m = (req.headers.cookie || "").match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : "";
}
function setSession(req, res, auth) {
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `eryapi_oturum=${makeToken(auth)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 3600}${secure}`);
}
const fails = new Map();
const tooMany = (ip) => { const f = fails.get(ip); return f && f.n >= 6 && Date.now() - f.t < 10 * 60e3; };

/* ---------------- Uygulama ---------------- */
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(express.json({ limit: "4mb" }));
const str = (v, max = 2000) => String(v ?? "").trim().slice(0, max);
const uid = () => Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ---- Herkese açık ---- */
app.get("/api/site", wrap(async (req, res) => {
  const { mesajlar, ...pub } = await loadDb();
  res.set("Cache-Control", "no-store").json(pub);
}));

const msgLimit = new Map();
app.post("/api/mesaj", wrap(async (req, res) => {
  const ip = req.ip;
  const recent = (msgLimit.get(ip) || []).filter((t) => Date.now() - t < 60 * 60e3);
  if (recent.length >= 8) return res.status(429).json({ hata: "Çok fazla mesaj gönderildi, lütfen daha sonra deneyin." });
  const b = req.body || {};
  if (b.website) return res.json({ ok: true }); // bot tuzağı
  const ad = str(b.ad, 120), telefon = str(b.telefon, 40);
  if (!ad || !telefon) return res.status(400).json({ hata: "Ad soyad ve telefon gerekli." });
  const db = await loadDb();
  db.mesajlar = [{ id: uid(), ad, telefon, tur: str(b.tur, 80), mesaj: str(b.mesaj, 3000), tarih: new Date().toISOString(), okundu: false }, ...(db.mesajlar || [])].slice(0, 2000);
  await saveDb(db);
  recent.push(Date.now()); msgLimit.set(ip, recent);
  res.json({ ok: true });
}));

/* ---- Giriş ---- */
app.post("/api/giris", wrap(async (req, res) => {
  const ip = req.ip;
  if (tooMany(ip)) return res.status(429).json({ hata: "Çok fazla hatalı deneme. 10 dakika sonra tekrar deneyin." });
  const auth = await loadAuth();
  if (!checkPassword(auth, req.body && req.body.sifre)) {
    const f = fails.get(ip) || { n: 0, t: Date.now() };
    if (Date.now() - f.t > 10 * 60e3) { f.n = 0; f.t = Date.now(); }
    f.n++; fails.set(ip, f);
    return res.status(401).json({ hata: "Şifre hatalı." });
  }
  fails.delete(ip);
  setSession(req, res, auth);
  res.json({ ok: true });
}));
app.post("/api/cikis", (req, res) => {
  res.setHeader("Set-Cookie", "eryapi_oturum=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
  res.json({ ok: true });
});
app.get("/api/oturum", wrap(async (req, res) => {
  res.json({ giris: validToken(await loadAuth(), getCookie(req, "eryapi_oturum")) });
}));

/* ---- Yönetim ---- */
const admin = express.Router();
admin.use(wrap(async (req, res, next) => {
  if (validToken(await loadAuth(), getCookie(req, "eryapi_oturum"))) return next();
  res.status(401).json({ hata: "Oturum gerekli" });
}));
// her yönetim isteğinde güncel içeriği oku
admin.use(wrap(async (req, res, next) => { req.db = await loadDb(); req.db.mesajlar = req.db.mesajlar || []; next(); }));

admin.get("/veri", (req, res) => res.set("Cache-Control", "no-store").json({ ...req.db, _depolama: storageInfo() }));

const SECTIONS = {
  ayarlar: (v, db) => Object.fromEntries(Object.keys(SEED.ayarlar).map((k) => [k, str(v[k] ?? db.ayarlar[k], 500)])),
  metinler: (v, db) => Object.fromEntries(Object.keys(SEED.metinler).map((k) => [k, str(v[k] ?? db.metinler[k], 3000)])),
  rakamlar: (v) => (Array.isArray(v) ? v : []).slice(0, 4).map((r) => ({ deger: str(r.deger, 20), etiket: str(r.etiket, 160) })),
  hizmetler: (v, db) => db.hizmetler.map((h) => { const n = (Array.isArray(v) ? v : []).find((x) => x.id === h.id) || h; return { id: h.id, ad: str(n.ad, 80) || h.ad, aciklama: str(n.aciklama, 400) }; }),
  surec: (v) => (Array.isArray(v) ? v : []).slice(0, 6).map((s) => ({ baslik: str(s.baslik, 80), metin: str(s.metin, 400) })),
  gorseller: (v) => ({
    heroVideo: str(v.heroVideo, 500),
    heroSlaytlar: (Array.isArray(v.heroSlaytlar) ? v.heroSlaytlar : []).slice(0, 8).map((x) => str(x, 500)).filter(Boolean),
    araBolum: str(v.araBolum, 500),
    galeri: (Array.isArray(v.galeri) ? v.galeri : []).slice(0, 5).map((g) => ({ src: str(g.src, 500), etiket: str(g.etiket, 60) })).filter((g) => g.src),
  }),
};
admin.put("/bolum/:ad", wrap(async (req, res) => {
  const fn = SECTIONS[req.params.ad];
  if (!fn) return res.status(404).json({ hata: "Bölüm yok" });
  req.db[req.params.ad] = fn(req.body || {}, req.db);
  await saveDb(req.db);
  res.json(req.db[req.params.ad]);
}));

function cleanProject(db, b, old = {}) {
  const kats = db.hizmetler.map((h) => h.id);
  return {
    id: old.id || uid(),
    baslik: str(b.baslik, 120) || "Adsız proje",
    kategori: kats.includes(b.kategori) ? b.kategori : kats[0],
    konum: str(b.konum, 120),
    yil: str(b.yil, 10),
    durum: b.durum === "Devam ediyor" ? "Devam ediyor" : "Tamamlandı",
    aciklama: str(b.aciklama, 3000),
    kapak: str(b.kapak, 500),
    galeri: (Array.isArray(b.galeri) ? b.galeri : []).slice(0, 30).map((x) => str(x, 500)).filter(Boolean),
  };
}
admin.post("/projeler", wrap(async (req, res) => {
  const p = cleanProject(req.db, req.body || {});
  req.db.projeler.unshift(p); await saveDb(req.db); res.json(p);
}));
admin.put("/projeler/:id", wrap(async (req, res) => {
  const i = req.db.projeler.findIndex((p) => p.id === req.params.id);
  if (i < 0) return res.status(404).json({ hata: "Proje bulunamadı" });
  req.db.projeler[i] = cleanProject(req.db, req.body || {}, req.db.projeler[i]);
  await saveDb(req.db); res.json(req.db.projeler[i]);
}));
admin.delete("/projeler/:id", wrap(async (req, res) => {
  req.db.projeler = req.db.projeler.filter((p) => p.id !== req.params.id); await saveDb(req.db); res.json({ ok: true });
}));
admin.post("/projeler-sira", wrap(async (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
  const map = new Map(req.db.projeler.map((p) => [p.id, p]));
  req.db.projeler = [...ids.map((id) => map.get(id)).filter(Boolean), ...req.db.projeler.filter((p) => !ids.includes(p.id))];
  await saveDb(req.db); res.json({ ok: true });
}));

admin.put("/mesajlar/:id", wrap(async (req, res) => {
  const m = req.db.mesajlar.find((x) => x.id === req.params.id);
  if (!m) return res.status(404).json({ hata: "Mesaj yok" });
  m.okundu = !!(req.body && req.body.okundu); await saveDb(req.db); res.json(m);
}));
admin.delete("/mesajlar/:id", wrap(async (req, res) => {
  req.db.mesajlar = req.db.mesajlar.filter((x) => x.id !== req.params.id); await saveDb(req.db); res.json({ ok: true });
}));

/* ---- Dosya yükleme ---- */
const IMG = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" };
const VID = { "video/mp4": ".mp4", "video/webm": ".webm" };
// Vercel: tarayıcı dosyayı doğrudan Vercel Blob'a yükler, sunucu yalnızca izin (token) verir
admin.post("/blob", wrap(async (req, res) => {
  if (!USE_BLOB) return res.status(400).json({ hata: "Vercel Blob bağlı değil. BENIOKU.txt'deki adımları izleyin." });
  const { handleUpload } = require("@vercel/blob/client");
  const out = await handleUpload({
    body: req.body,
    request: req,
    onBeforeGenerateToken: async () => ({
      allowedContentTypes: [...Object.keys(IMG), ...Object.keys(VID)],
      maximumSizeInBytes: 250 * 1024 * 1024,
      addRandomSuffix: true,
    }),
  });
  res.json(out);
}));
// Yerel: dosya sunucu üzerinden public/uploads klasörüne kaydedilir
let uploader = null;
function getUploader() {
  if (uploader) return uploader;
  const multer = require("multer");
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  uploader = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, UPLOAD_DIR),
      filename: (req, file, cb) => cb(null, uid() + (IMG[file.mimetype] || VID[file.mimetype])),
    }),
    limits: { fileSize: 250 * 1024 * 1024 },
    fileFilter: (req, file, cb) => cb(null, !!(IMG[file.mimetype] || VID[file.mimetype])),
  }).single("dosya");
  return uploader;
}
admin.post("/yukle", (req, res, next) => {
  if (ON_VERCEL) return res.status(400).json({ hata: USE_BLOB ? "Vercel'de yükleme doğrudan Blob'a yapılır." : "Fotoğraf yüklemek için Vercel Blob bağlanmalı. BENIOKU.txt'deki adımları izleyin." });
  let up; try { up = getUploader(); } catch (e) { return res.status(500).json({ hata: "Yükleme klasörü oluşturulamadı: " + e.message }); }
  up(req, res, (err) => {
    if (err) return next(err);
    if (!req.file) return res.status(400).json({ hata: "Desteklenmeyen dosya. JPG, PNG, WEBP, MP4 veya WEBM yükleyin." });
    if (IMG[req.file.mimetype] && req.file.size > 20 * 1024 * 1024) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ hata: "Görsel 20 MB'tan büyük olamaz." });
    }
    res.json({ yol: "uploads/" + req.file.filename });
  });
});

/* ---- Şifre ve yedek ---- */
admin.post("/sifre", wrap(async (req, res) => {
  const { eski, yeni } = req.body || {};
  if (!checkPassword(await loadAuth(), eski)) return res.status(400).json({ hata: "Mevcut şifre hatalı." });
  if (!yeni || String(yeni).length < 8) return res.status(400).json({ hata: "Yeni şifre en az 8 karakter olmalı." });
  if (storageInfo().icerik === "gecici") return res.status(400).json({ hata: "Kalıcı depolama (Upstash Redis) bağlı olmadığı için şifre kaydedilemez." });
  const a = newAuth(String(yeni));
  await saveAuth(a);
  setSession(req, res, a);
  res.json({ ok: true });
}));
admin.get("/yedek", (req, res) => {
  res.setHeader("Content-Disposition", `attachment; filename="eryapi-yedek-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(req.db);
});
admin.post("/geri-yukle", wrap(async (req, res) => {
  const b = req.body;
  if (!b || !Array.isArray(b.projeler) || !b.ayarlar || !b.metinler) return res.status(400).json({ hata: "Geçersiz yedek dosyası." });
  const { _depolama, ...rest } = b;
  await saveDb({ ...req.db, ...rest, mesajlar: Array.isArray(b.mesajlar) ? b.mesajlar : req.db.mesajlar });
  res.json({ ok: true });
}));

app.use("/api/yonetim", admin);
app.use("/api", (req, res) => res.status(404).json({ hata: "Bulunamadı" }));

/* ---- Sayfalar ----
   Vercel ana sayfa ve panel isteklerini bu fonksiyona yönlendirdiği için HTML ve panel dosyaları
   burada da sunulur (yollar sabit yazıldı ki Vercel bu dosyaları pakete dahil etsin). */
const PAGES = {
  "/": [() => fs.readFileSync(path.join(__dirname, "public", "index.html")), "text/html; charset=utf-8"],
  "/index.html": [() => fs.readFileSync(path.join(__dirname, "public", "index.html")), "text/html; charset=utf-8"],
  "/admin": [() => fs.readFileSync(path.join(__dirname, "public", "admin", "index.html")), "text/html; charset=utf-8"],
  "/admin/": [() => fs.readFileSync(path.join(__dirname, "public", "admin", "index.html")), "text/html; charset=utf-8"],
  "/admin/index.html": [() => fs.readFileSync(path.join(__dirname, "public", "admin", "index.html")), "text/html; charset=utf-8"],
  "/admin/admin.js": [() => fs.readFileSync(path.join(__dirname, "public", "admin", "admin.js")), "application/javascript; charset=utf-8"],
  "/admin/admin.css": [() => fs.readFileSync(path.join(__dirname, "public", "admin", "admin.css")), "text/css; charset=utf-8"],
  "/admin/blob-client.js": [() => fs.readFileSync(path.join(__dirname, "public", "admin", "blob-client.js")), "application/javascript; charset=utf-8"],
};
app.get(Object.keys(PAGES), (req, res, next) => {
  const p = PAGES[req.path];
  if (!p) return next();
  try { res.type(p[1]).set("Cache-Control", "no-cache").send(p[0]()); } catch (e) { next(e); }
});

/* ---- Diğer statik dosyalar (görseller vb.; Vercel'de bunları public/ klasöründen CDN sunar) ---- */
if (!ON_VERCEL) {
  app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));
}

app.use((err, req, res, next) => {
  if (err && err.code === "LIMIT_FILE_SIZE") return res.status(400).json({ hata: "Dosya çok büyük (en fazla 250 MB)." });
  console.error(err);
  res.status(500).json({ hata: "Sunucu hatası: " + (err && err.message ? err.message : "bilinmeyen") });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log("\n  ER Yapı İnşaat çalışıyor");
    console.log("  Site:  http://localhost:" + PORT);
    console.log("  Panel: http://localhost:" + PORT + "/admin\n");
  });
}
module.exports = app;
