/* ER Yapı İnşaat — Yönetim Paneli */
(function () {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const src = (p) => (!p ? "" : /^(https?:|data:|blob:|\/)/.test(p) ? p : "/" + p);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  let DB = null;

  /* ---------- yardımcılar ---------- */
  async function api(url, opt = {}) {
    const o = { method: "GET", headers: {}, ...opt };
    if (o.body && !(o.body instanceof FormData) && typeof o.body !== "string") { o.headers["Content-Type"] = "application/json"; o.body = JSON.stringify(o.body); }
    const r = await fetch(url, o);
    if (r.status === 401 && !url.endsWith("/giris")) { showLogin(); throw new Error("Oturum süresi doldu, lütfen tekrar giriş yapın."); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.hata || "İşlem başarısız");
    return j;
  }
  function toast(t, bad) {
    const d = document.createElement("div");
    d.className = "toast" + (bad ? " bad" : ""); d.textContent = t;
    $("#toasts").appendChild(d); setTimeout(() => d.remove(), 3200);
  }
  const fail = (e) => toast(e.message || String(e), true);
  function modal(html, cls = "") {
    const m = $("#modal"), b = $("#modalBox");
    b.className = "modal-box " + cls; b.innerHTML = html; m.hidden = false; document.body.style.overflow = "hidden";
    const f = b.querySelector("input,select,textarea"); if (f) setTimeout(() => f.focus(), 50);
    return b;
  }
  function closeModal() { $("#modal").hidden = true; $("#modalBox").innerHTML = ""; document.body.style.overflow = ""; }
  $("#modal").addEventListener("mousedown", (e) => { if (e.target.id === "modal") closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#modal").hidden) closeModal(); });
  function confirmBox(text, okText = "Sil") {
    return new Promise((res) => {
      const b = modal(`<div class="modal-h"><h2>Emin misiniz?</h2></div><p class="muted">${esc(text)}</p><div class="modal-f"><button class="btn" data-x="0">Vazgeç</button><button class="btn dark" data-x="1">${esc(okText)}</button></div>`, "sm");
      b.onclick = (e) => { const x = e.target.closest("[data-x]"); if (x) { closeModal(); res(x.dataset.x === "1"); } };
    });
  }
  function pickFiles(accept, multiple) {
    return new Promise((res) => {
      const i = document.createElement("input");
      i.type = "file"; i.accept = accept; i.multiple = !!multiple;
      i.onchange = () => res([...i.files]); i.click();
    });
  }
  /* Görseli tarayıcıda küçültüp yükler (en fazla 2000 px) */
  async function shrink(file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error(file.name + ": yalnızca JPG, PNG veya WEBP görsel yükleyebilirsiniz.");
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error(file.name + " okunamadı")); i.src = url; });
      const max = 2000, sc = Math.min(1, max / Math.max(img.width, img.height));
      if (sc === 1 && file.size < 1.5e6) return file;
      const c = document.createElement("canvas"); c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      const blob = await new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.86));
      return new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
    } finally { URL.revokeObjectURL(url); }
  }
  /* Vercel'de dosya doğrudan Vercel Blob'a, yerelde sunucuya yüklenir */
  async function uploadRaw(file, onProg) {
    const mode = DB && DB._depolama ? DB._depolama.dosyalar : "dosya";
    if (mode === "yok") throw new Error("Fotoğraf yüklemek için Vercel Blob bağlanmalı (BENIOKU.txt).");
    if (mode === "blob") {
      if (!window.BlobClient) throw new Error("Yükleme bileşeni yüklenemedi, sayfayı yenileyin.");
      const ext = (file.name.match(/\.\w+$/) || [""])[0].toLowerCase();
      const r = await window.BlobClient.upload("eryapi/" + Date.now().toString(36) + ext, file, {
        access: "public", handleUploadUrl: "/api/yonetim/blob", contentType: file.type,
        onUploadProgress: (e) => onProg && onProg(e.percentage / 100),
      });
      return r.url;
    }
    return uploadLocal(file, onProg);
  }
  function uploadLocal(file, onProg) {
    return new Promise((res, rej) => {
      const fd = new FormData(); fd.append("dosya", file);
      const x = new XMLHttpRequest(); x.open("POST", "/api/yonetim/yukle");
      x.upload.onprogress = (e) => e.lengthComputable && onProg && onProg(e.loaded / e.total);
      x.onload = () => { let j = {}; try { j = JSON.parse(x.responseText); } catch (e) {} if (x.status === 401) { showLogin(); return rej(new Error("Oturum süresi doldu")); } x.status < 300 ? res(j.yol) : rej(new Error(j.hata || "Yükleme başarısız")); };
      x.onerror = () => rej(new Error("Bağlantı hatası")); x.send(fd);
    });
  }
  async function uploadImages(multiple) {
    const files = await pickFiles("image/jpeg,image/png,image/webp", multiple);
    const out = [];
    for (const f of files) {
      try { out.push(await uploadRaw(await shrink(f))); } catch (e) { fail(e); }
    }
    if (out.length) toast(out.length + " görsel yüklendi");
    return out;
  }

  /* ---------- oturum ---------- */
  function showLogin() { $("#boot").hidden = true; $("#app").hidden = true; $("#login").hidden = false; closeModal(); setTimeout(() => $("#pw").focus(), 30); }
  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault(); const btn = e.submitter || $("#loginForm button"); btn.disabled = true; $("#loginErr").hidden = true;
    try { await api("/api/giris", { method: "POST", body: { sifre: $("#pw").value } }); $("#pw").value = ""; await start(); }
    catch (err) { $("#loginErr").textContent = err.message; $("#loginErr").hidden = false; }
    finally { btn.disabled = false; }
  });
  $("#logout").onclick = async () => { await api("/api/cikis", { method: "POST" }).catch(() => {}); showLogin(); };

  async function start() {
    DB = await api("/api/yonetim/veri");
    $("#boot").hidden = true; $("#login").hidden = true; $("#app").hidden = false;
    route();
  }

  /* ---------- sekmeler ---------- */
  const TABS = [
    ["genel", "Genel bakış"], ["projeler", "Projeler"], ["gorseller", "Site görselleri"], ["metinler", "Metinler"],
    ["hizmetler", "Hizmetler ve süreç"], ["iletisim", "İletişim bilgileri"], ["mesajlar", "Mesajlar"], ["ayarlar", "Ayarlar"],
  ];
  const unread = () => DB.mesajlar.filter((m) => !m.okundu).length;
  function drawTabs(cur) {
    $("#tabs").innerHTML = TABS.map(([id, t]) => `<a href="#${id}" class="${id === cur ? "on" : ""}">${t}${id === "mesajlar" && unread() ? ` <span class="badge">${unread()}</span>` : ""}</a>`).join("");
  }
  const VIEWS = {};
  function route() {
    if (!DB) return;
    const id = (location.hash || "#genel").slice(1);
    const v = VIEWS[id] ? id : "genel";
    drawTabs(v); VIEWS[v]($("#view")); window.scrollTo(0, 0);
    const st = DB._depolama || {};
    if (st.icerik === "gecici" || st.dosyalar === "yok") {
      const w = document.createElement("p"); w.className = "hint warn";
      w.innerHTML = st.icerik === "gecici"
        ? "<b>Dikkat:</b> Kalıcı depolama (Upstash Redis) bağlı değil. Yaptığınız değişiklikler kısa süre sonra kaybolur. Kurulum: BENIOKU.txt → “Vercel'e yükleme”."
        : "<b>Dikkat:</b> Vercel Blob bağlı değil, fotoğraf ve video yüklenemez. Kurulum: BENIOKU.txt → “Vercel'e yükleme”.";
      $("#view").prepend(w);
    }
  }
  addEventListener("hashchange", route);
  const catName = (id) => (DB.hizmetler.find((h) => h.id === id) || { ad: id }).ad;
  const fmtDate = (s) => new Date(s).toLocaleString("tr-TR", { day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const savebar = (label = "Değişiklikleri kaydet") => `<div class="savebar"><button class="btn gold" data-save>${label}</button></div>`;
  async function saveSection(name, data, btn) {
    if (btn) btn.disabled = true;
    try { DB[name] = await api("/api/yonetim/bolum/" + name, { method: "PUT", body: data }); toast("Kaydedildi. Değişiklik sitede yayında."); }
    catch (e) { fail(e); } finally { if (btn) btn.disabled = false; }
  }

  /* ---------- Genel bakış ---------- */
  VIEWS.genel = (el) => {
    const live = DB.projeler.filter((p) => p.durum === "Devam ediyor").length;
    const last = DB.mesajlar.slice(0, 3);
    el.innerHTML = `<div class="head"><div><h1>Hoş geldiniz</h1><p class="muted">Sitedeki her şeyi buradan güncelleyebilirsiniz. Kaydettiğiniz değişiklikler sitede hemen görünür.</p></div><a class="btn dark" href="#projeler" data-new>+ Yeni proje ekle</a></div>
    <div class="stats">
      <a class="stat" href="#projeler"><b>${DB.projeler.length}</b><span>toplam proje</span></a>
      <a class="stat" href="#projeler"><b>${live}</b><span>devam eden proje</span></a>
      <a class="stat" href="#mesajlar"><b>${unread()}</b><span>okunmamış mesaj</span></a>
      <a class="stat" href="#gorseller"><b>${DB.gorseller.heroSlaytlar.length}</b><span>ana sayfa görseli</span></a>
    </div>
    <div class="grid2">
      <div class="card"><div class="card-h"><h2>Son mesajlar</h2><a class="btn sm" href="#mesajlar">Tümü</a></div>
        ${last.length ? last.map((m) => `<div class="msg${m.okundu ? "" : " new"}"><div class="msg-h"><b>${esc(m.ad)}</b><span class="muted small">${fmtDate(m.tarih)}</span></div><span class="small">${esc(m.telefon)}${m.tur ? " · " + esc(m.tur) : ""}</span>${m.mesaj ? `<p class="small">${esc(m.mesaj.slice(0, 160))}${m.mesaj.length > 160 ? "…" : ""}</p>` : ""}</div>`).join("") : `<div class="empty">Henüz mesaj yok. İletişim formundan gelen mesajlar burada görünür.</div>`}
      </div>
      <div class="card"><div class="card-h"><h2>Hızlı işlemler</h2></div>
        <div class="stack">
          <a class="btn" href="#projeler" data-new>Yeni proje ekle</a>
          <a class="btn" href="#gorseller">Ana sayfa görsellerini değiştir</a>
          <a class="btn" href="#metinler">Site metinlerini düzenle</a>
          <a class="btn" href="#iletisim">Telefon ve adres bilgilerini güncelle</a>
        </div>
      </div>
    </div>`;
    $$("[data-new]", el).forEach((a) => a.addEventListener("click", () => setTimeout(() => editProject(null), 60)));
  };

  /* ---------- Projeler ---------- */
  let pq = "", pcat = "";
  VIEWS.projeler = (el) => {
    el.innerHTML = `<div class="head"><div><h1>Projeler</h1><p class="muted">Sitede "Projelerimiz" bölümünde bu sırayla görünür. Okla sırayı değiştirebilirsiniz.</p></div><button class="btn dark" id="pNew">+ Yeni proje</button></div>
    <div class="toolbar"><input id="pq" type="search" placeholder="Proje ara…" value="${esc(pq)}"><select id="pcat"><option value="">Tüm kategoriler</option>${DB.hizmetler.map((h) => `<option value="${esc(h.id)}"${pcat === h.id ? " selected" : ""}>${esc(h.ad)}</option>`).join("")}</select></div>
    <div class="plist" id="plist"></div>`;
    const draw = () => {
      const q = pq.toLocaleLowerCase("tr");
      const list = DB.projeler.filter((p) => (!pcat || p.kategori === pcat) && (!q || (p.baslik + " " + p.konum).toLocaleLowerCase("tr").includes(q)));
      $("#plist").innerHTML = list.length ? list.map((p) => `<div class="prow" data-id="${esc(p.id)}">
        <div class="th">${p.kapak ? `<img src="${esc(src(p.kapak))}" alt="">` : ""}</div>
        <div><h3>${esc(p.baslik)}</h3><div class="meta"><span class="pill${p.durum === "Devam ediyor" ? " live" : ""}">${esc(p.durum)}</span>${esc(catName(p.kategori))}${p.konum ? " · " + esc(p.konum) : ""}${p.yil ? " · " + esc(p.yil) : ""}${p.galeri && p.galeri.length ? ` · ${p.galeri.length + 1} görsel` : ""}</div></div>
        <div class="acts">${!pq && !pcat ? `<button class="btn sm icon-btn" data-up aria-label="Yukarı taşı">↑</button><button class="btn sm icon-btn" data-down aria-label="Aşağı taşı">↓</button>` : ""}<button class="btn sm" data-edit>Düzenle</button><button class="btn sm danger" data-del>Sil</button></div></div>`).join("")
        : `<div class="empty">${DB.projeler.length ? "Aramanıza uyan proje yok." : "Henüz proje yok. “Yeni proje” ile ekleyin."}</div>`;
    };
    draw();
    $("#pq").oninput = (e) => { pq = e.target.value; draw(); };
    $("#pcat").onchange = (e) => { pcat = e.target.value; draw(); };
    $("#pNew").onclick = () => editProject(null);
    $("#plist").onclick = async (e) => {
      const row = e.target.closest(".prow"); if (!row) return;
      const id = row.dataset.id, i = DB.projeler.findIndex((p) => p.id === id), p = DB.projeler[i];
      if (e.target.closest("[data-edit]")) editProject(p);
      if (e.target.closest("[data-del]") && (await confirmBox(`“${p.baslik}” projesi silinecek. Bu işlem geri alınamaz.`))) {
        try { await api("/api/yonetim/projeler/" + id, { method: "DELETE" }); DB.projeler.splice(i, 1); draw(); toast("Proje silindi"); } catch (er) { fail(er); }
      }
      const dir = e.target.closest("[data-up]") ? -1 : e.target.closest("[data-down]") ? 1 : 0;
      if (dir && DB.projeler[i + dir]) {
        [DB.projeler[i], DB.projeler[i + dir]] = [DB.projeler[i + dir], DB.projeler[i]]; draw();
        api("/api/yonetim/projeler-sira", { method: "POST", body: { ids: DB.projeler.map((x) => x.id) } }).catch(fail);
      }
    };
  };
  function editProject(p) {
    const d = p ? clone(p) : { baslik: "", kategori: DB.hizmetler[0].id, konum: "Akşehir / Konya", yil: String(new Date().getFullYear()), durum: "Tamamlandı", aciklama: "", kapak: "", galeri: [] };
    const b = modal(`<div class="modal-h"><h2>${p ? "Projeyi düzenle" : "Yeni proje"}</h2><button class="btn sm" data-close>Kapat</button></div>
      <form id="pf" class="stack">
        <label class="field">Proje adı<input id="f_baslik" required maxlength="120" value="${esc(d.baslik)}"></label>
        <div class="grid2">
          <label class="field">Kategori<select id="f_kategori">${DB.hizmetler.map((h) => `<option value="${esc(h.id)}"${h.id === d.kategori ? " selected" : ""}>${esc(h.ad)}</option>`).join("")}</select></label>
          <label class="field">Durum<select id="f_durum">${["Tamamlandı", "Devam ediyor"].map((s) => `<option${s === d.durum ? " selected" : ""}>${s}</option>`).join("")}</select></label>
          <label class="field">Konum<input id="f_konum" maxlength="120" value="${esc(d.konum)}"></label>
          <label class="field">Yıl<input id="f_yil" inputmode="numeric" maxlength="10" value="${esc(d.yil)}"></label>
        </div>
        <label class="field">Açıklama<textarea id="f_aciklama" maxlength="3000">${esc(d.aciklama)}</textarea></label>
        <div class="field">Fotoğraflar <small>İlk fotoğraf kapak olarak kullanılır. Bir fotoğrafa “Kapak yap” diyerek değiştirebilirsiniz.</small><div class="imgs" id="pimgs"></div></div>
        <div class="modal-f"><button type="button" class="btn" data-close>Vazgeç</button><button class="btn gold" type="submit">${p ? "Kaydet" : "Projeyi ekle"}</button></div>
      </form>`);
    const imgs = () => [d.kapak, ...(d.galeri || [])].filter(Boolean);
    const setImgs = (a) => { d.kapak = a[0] || ""; d.galeri = a.slice(1); drawImgs(); };
    function drawImgs() {
      const a = imgs();
      $("#pimgs", b).innerHTML = a.map((s, i) => `<div class="img">${i === 0 ? '<span class="tag">Kapak</span>' : ""}<img src="${esc(src(s))}" alt=""><div class="ov">${i ? `<button type="button" class="btn sm" data-cover="${i}">Kapak yap</button>` : ""}<button type="button" class="btn sm danger" data-rm="${i}">Kaldır</button></div></div>`).join("") + `<button type="button" class="add" data-add><span><b>+</b>Fotoğraf ekle</span></button>`;
    }
    drawImgs();
    b.onclick = async (e) => {
      if (e.target.closest("[data-close]")) return closeModal();
      const a = imgs();
      const c = e.target.closest("[data-cover]"); if (c) { const i = +c.dataset.cover; a.unshift(a.splice(i, 1)[0]); setImgs(a); }
      const r = e.target.closest("[data-rm]"); if (r) { a.splice(+r.dataset.rm, 1); setImgs(a); }
      const ad = e.target.closest("[data-add]"); if (ad) { ad.disabled = true; ad.innerHTML = "<span>Yükleniyor…</span>"; const up = await uploadImages(true); setImgs([...imgs(), ...up]); }
    };
    $("#pf", b).onsubmit = async (e) => {
      e.preventDefault(); const btn = e.submitter; btn.disabled = true;
      ["baslik", "kategori", "durum", "konum", "yil", "aciklama"].forEach((k) => (d[k] = $("#f_" + k, b).value.trim()));
      try {
        if (p) { const n = await api("/api/yonetim/projeler/" + p.id, { method: "PUT", body: d }); DB.projeler[DB.projeler.findIndex((x) => x.id === p.id)] = n; }
        else { DB.projeler.unshift(await api("/api/yonetim/projeler", { method: "POST", body: d })); }
        closeModal(); toast(p ? "Proje güncellendi" : "Proje eklendi"); if (location.hash !== "#projeler") location.hash = "#projeler"; else route();
      } catch (er) { fail(er); btn.disabled = false; }
    };
  }

  /* ---------- Site görselleri ---------- */
  VIEWS.gorseller = (el) => {
    const G = clone(DB.gorseller);
    while (G.galeri.length < 5) G.galeri.push({ src: "", etiket: "" });
    el.innerHTML = `<div class="head"><div><h1>Site görselleri</h1><p class="muted">Ana sayfa, ara bölüm ve galeri görselleri. Değişiklikler “Kaydet” ile yayına alınır.</p></div></div>
    <div class="card"><div class="card-h"><div><h2>Ana sayfa slaytları</h2><p class="muted small">Açılıştaki tam ekran görseller, bu sırayla 7 saniyede bir değişir. En fazla 8 görsel. Yatay ve yüksek çözünürlüklü fotoğraflar en iyi sonucu verir.</p></div></div><div class="imgs" id="gHero"></div></div>
    <div class="card"><div class="card-h"><div><h2>Ana sayfa videosu</h2><p class="muted small">Video yüklerseniz slaytların yerine sessiz ve döngülü olarak oynar. MP4 önerilir; 30 MB altı tutmanız sitenin hızlı açılması için iyi olur.</p></div></div><div class="single" id="gVideo"></div></div>
    <div class="card"><div class="card-h"><div><h2>Ara bölüm görseli</h2><p class="muted small">“Tasarımdan anahtar teslime, tek muhatap” yazısının arkasındaki geniş görsel.</p></div></div><div class="single" id="gAra"></div></div>
    <div class="card"><div class="card-h"><div><h2>Galeri</h2><p class="muted small">Instagram bölümündeki 5 görsel. İlk görsel büyük ve dikey gösterilir. Altındaki kısa yazı isteğe bağlıdır.</p></div></div><div id="gGal"></div></div>
    ${savebar()}`;
    const drawHero = () => {
      $("#gHero").innerHTML = G.heroSlaytlar.map((s, i) => `<div class="img">${i === 0 ? '<span class="tag">İlk</span>' : ""}<img src="${esc(src(s))}" alt=""><div class="ov">${i ? `<button class="btn sm" data-l="${i}" aria-label="Öne al">←</button>` : ""}${i < G.heroSlaytlar.length - 1 ? `<button class="btn sm" data-r="${i}" aria-label="Arkaya al">→</button>` : ""}<button class="btn sm danger" data-rm="${i}">Kaldır</button></div></div>`).join("") + (G.heroSlaytlar.length < 8 ? `<button class="add" data-add><span><b>+</b>Görsel ekle</span></button>` : "");
    };
    const drawVideo = () => {
      $("#gVideo").innerHTML = G.heroVideo
        ? `<div class="img"><video src="${esc(src(G.heroVideo))}" muted loop autoplay playsinline></video></div><div class="stack"><p class="small">Video yayında. Slaytlar video kaldırılınca tekrar görünür.</p><div><button class="btn danger" data-vrm>Videoyu kaldır</button></div></div>`
        : `<button class="add" data-vadd><span><b>+</b>Video yükle</span></button><div class="stack"><p class="small muted">Şu an video yok, slaytlar gösteriliyor.</p><div class="progress" hidden id="vprog"><i></i></div></div>`;
    };
    const drawAra = () => { $("#gAra").innerHTML = `<div class="img"><img src="${esc(src(G.araBolum))}" alt=""></div><div><button class="btn" data-ara>Görseli değiştir</button></div>`; };
    const drawGal = () => {
      $("#gGal").innerHTML = G.galeri.map((g, i) => `<div class="gal-row">${g.src ? `<div class="img"><img src="${esc(src(g.src))}" alt=""><div class="ov"><button class="btn sm danger" data-grm="${i}">Kaldır</button></div></div>` : `<button class="add" data-gadd="${i}"><span><b>+</b>Ekle</span></button>`}<div class="stack" style="gap:8px"><label class="field">${i === 0 ? "Büyük görsel" : i + 1 + ". görsel"} yazısı<input data-gl="${i}" maxlength="60" value="${esc(g.etiket)}" placeholder="Örn. Lobi"></label>${g.src ? `<div><button class="btn sm" data-gadd="${i}">Değiştir</button></div>` : ""}</div></div>`).join("");
    };
    drawHero(); drawVideo(); drawAra(); drawGal();
    el.oninput = (e) => { const g = e.target.dataset.gl; if (g != null) G.galeri[+g].etiket = e.target.value; };
    el.onclick = async (e) => {
      const t = e.target.closest("button"); if (!t) return;
      const H = G.heroSlaytlar;
      if (t.dataset.rm != null) { H.splice(+t.dataset.rm, 1); drawHero(); }
      if (t.dataset.l != null) { const i = +t.dataset.l; [H[i - 1], H[i]] = [H[i], H[i - 1]]; drawHero(); }
      if (t.dataset.r != null) { const i = +t.dataset.r; [H[i + 1], H[i]] = [H[i], H[i + 1]]; drawHero(); }
      if (t.hasAttribute("data-add")) { const up = await uploadImages(true); G.heroSlaytlar = [...H, ...up].slice(0, 8); drawHero(); }
      if (t.hasAttribute("data-ara")) { const up = await uploadImages(false); if (up[0]) { G.araBolum = up[0]; drawAra(); } }
      if (t.dataset.gadd != null) { const up = await uploadImages(false); if (up[0]) { G.galeri[+t.dataset.gadd].src = up[0]; drawGal(); } }
      if (t.dataset.grm != null) { G.galeri[+t.dataset.grm].src = ""; drawGal(); }
      if (t.hasAttribute("data-vrm")) { G.heroVideo = ""; drawVideo(); }
      if (t.hasAttribute("data-vadd")) {
        const [f] = await pickFiles("video/mp4,video/webm", false); if (!f) return;
        if (!/^video\/(mp4|webm)$/.test(f.type)) return fail(new Error("Yalnızca MP4 veya WEBM video yükleyebilirsiniz."));
        t.disabled = true; const pr = $("#vprog"); pr.hidden = false;
        try { G.heroVideo = await uploadRaw(f, (x) => (pr.firstChild.style.width = Math.round(x * 100) + "%")); toast("Video yüklendi. Yayına almak için Kaydet'e basın."); drawVideo(); }
        catch (er) { fail(er); t.disabled = false; pr.hidden = true; }
      }
      if (t.hasAttribute("data-save")) {
        if (!G.heroSlaytlar.length && !G.heroVideo) return fail(new Error("Ana sayfa için en az bir görsel ya da video gerekli."));
        await saveSection("gorseller", { ...G, galeri: G.galeri.filter((g) => g.src) }, t);
      }
    };
  };

  /* ---------- Metinler ---------- */
  const MET = [
    ["Ana sayfa (açılış)", [["heroUst", "Üst küçük yazı", "input"], ["heroBaslik1", "Büyük başlık – 1. satır", "input"], ["heroBaslik2", "Büyük başlık – 2. satır (altın renkli italik)", "input"], ["heroAlt", "Başlık altındaki açıklama", "textarea"]]],
    ["Hakkımızda", [["hakkimizda", "Hakkımızda paragrafı", "textarea"]]],
    ["Ara bölüm", [["farkBaslik", "Başlık", "input"], ["farkMetin", "Açıklama", "textarea"]]],
    ["İletişim ve alt bilgi", [["iletisimMetin", "İletişim bölümü açıklaması", "textarea"], ["footerMetin", "Sayfa altı kısa tanıtım", "textarea"]]],
  ];
  VIEWS.metinler = (el) => {
    const M = clone(DB.metinler), R = clone(DB.rakamlar);
    el.innerHTML = `<div class="head"><div><h1>Metinler</h1><p class="muted">Sitedeki yazıları buradan değiştirebilirsiniz.</p></div></div>
    <p class="hint">İpucu: Bir kelimeyi <b>*yıldız*</b> arasına yazarsanız sitede altın renkli italik görünür. Örnek: <b>*anahtar teslim*</b></p><br>
    ${MET.map(([t, fs]) => `<div class="card"><div class="card-h"><h2>${t}</h2></div><div class="stack">${fs.map(([k, l, type]) => `<label class="field">${l}${type === "textarea" ? `<textarea data-k="${k}" maxlength="3000">${esc(M[k])}</textarea>` : `<input data-k="${k}" maxlength="300" value="${esc(M[k])}">`}</label>`).join("")}</div></div>`).join("")}
    <div class="card"><div class="card-h"><div><h2>Rakamlar</h2><p class="muted small">Hakkımızda bölümünün altındaki büyük rakamlar. En fazla 4 tane.</p></div><button class="btn sm" id="rAdd">+ Rakam ekle</button></div><div id="rList"></div></div>
    ${savebar()}`;
    const drawR = () => {
      $("#rList").innerHTML = R.map((r, i) => `<div class="rowed"><label class="field">Değer<input data-rd="${i}" maxlength="20" value="${esc(r.deger)}" placeholder="15+"></label><label class="field">Açıklama<input data-re="${i}" maxlength="160" value="${esc(r.etiket)}"></label><button class="btn danger" data-rrm="${i}" aria-label="Sil">Sil</button></div>`).join("") || `<p class="muted small">Rakam yok.</p>`;
      $("#rAdd").disabled = R.length >= 4;
    };
    drawR();
    el.oninput = (e) => {
      const d = e.target.dataset;
      if (d.k) M[d.k] = e.target.value; if (d.rd) R[+d.rd].deger = e.target.value; if (d.re) R[+d.re].etiket = e.target.value;
    };
    el.onclick = async (e) => {
      const t = e.target.closest("button"); if (!t) return;
      if (t.id === "rAdd" && R.length < 4) { R.push({ deger: "", etiket: "" }); drawR(); }
      if (t.dataset.rrm != null) { R.splice(+t.dataset.rrm, 1); drawR(); }
      if (t.hasAttribute("data-save")) {
        t.disabled = true;
        try {
          DB.metinler = await api("/api/yonetim/bolum/metinler", { method: "PUT", body: M });
          DB.rakamlar = await api("/api/yonetim/bolum/rakamlar", { method: "PUT", body: R.filter((r) => r.deger || r.etiket) });
          toast("Kaydedildi. Değişiklik sitede yayında.");
        } catch (er) { fail(er); } finally { t.disabled = false; }
      }
    };
  };

  /* ---------- Hizmetler ve süreç ---------- */
  VIEWS.hizmetler = (el) => {
    const H = clone(DB.hizmetler), S = clone(DB.surec);
    el.innerHTML = `<div class="head"><div><h1>Hizmetler ve süreç</h1><p class="muted">Hizmet adları aynı zamanda proje kategorileridir.</p></div></div>
    <div class="card"><div class="card-h"><h2>Hizmetler</h2></div><div id="hList">${H.map((h, i) => `<div class="svc-ed"><label class="field">Ad<input data-ha="${i}" maxlength="80" value="${esc(h.ad)}"></label><label class="field">Açıklama<textarea data-hd="${i}" maxlength="400" style="min-height:70px">${esc(h.aciklama)}</textarea></label></div>`).join("")}</div></div>
    <div class="card"><div class="card-h"><div><h2>Hizmet süreci</h2><p class="muted small">“Dört disiplin, tek çatı” bölümündeki aşamalar.</p></div><button class="btn sm" id="sAdd">+ Aşama ekle</button></div><div id="sList"></div></div>
    ${savebar()}`;
    const drawS = () => {
      $("#sList").innerHTML = S.map((s, i) => `<div class="svc-ed"><label class="field">Aşama ${i + 1}<input data-sb="${i}" maxlength="80" value="${esc(s.baslik)}"></label><div class="stack" style="gap:8px"><label class="field">Açıklama<textarea data-sm="${i}" maxlength="400" style="min-height:70px">${esc(s.metin)}</textarea></label>${S.length > 1 ? `<div><button class="btn sm danger" data-srm="${i}">Aşamayı sil</button></div>` : ""}</div></div>`).join("");
      $("#sAdd").disabled = S.length >= 6;
    };
    drawS();
    el.oninput = (e) => {
      const d = e.target.dataset, v = e.target.value;
      if (d.ha) H[+d.ha].ad = v; if (d.hd) H[+d.hd].aciklama = v; if (d.sb) S[+d.sb].baslik = v; if (d.sm) S[+d.sm].metin = v;
    };
    el.onclick = async (e) => {
      const t = e.target.closest("button"); if (!t) return;
      if (t.id === "sAdd" && S.length < 6) { S.push({ baslik: "", metin: "" }); drawS(); }
      if (t.dataset.srm != null) { S.splice(+t.dataset.srm, 1); drawS(); }
      if (t.hasAttribute("data-save")) {
        t.disabled = true;
        try {
          DB.hizmetler = await api("/api/yonetim/bolum/hizmetler", { method: "PUT", body: H });
          DB.surec = await api("/api/yonetim/bolum/surec", { method: "PUT", body: S.filter((s) => s.baslik) });
          toast("Kaydedildi. Değişiklik sitede yayında.");
        } catch (er) { fail(er); } finally { t.disabled = false; }
      }
    };
  };

  /* ---------- İletişim bilgileri ---------- */
  const AY = [
    ["firma", "Firma adı"], ["yetkili", "Yetkili kişi"], ["telefon", "Telefon (sitede görünen)"], ["whatsapp", "WhatsApp numarası", "Ülke koduyla, boşluksuz. Örn. 905452841784"],
    ["eposta", "E-posta"], ["adres", "Adres"], ["haritaLink", "Google Haritalar bağlantısı", "Google Haritalar'da firmanızı açıp “Paylaş” ile aldığınız bağlantı"],
    ["instagram", "Instagram bağlantısı"], ["facebook", "Facebook bağlantısı"], ["tanitimVideoLink", "Tanıtım videosu bağlantısı", "Instagram bölümündeki “Tanıtım videosu” butonu buraya gider. Boş bırakırsanız buton gizlenir."],
  ];
  VIEWS.iletisim = (el) => {
    const A = clone(DB.ayarlar);
    el.innerHTML = `<div class="head"><div><h1>İletişim bilgileri</h1><p class="muted">Sitenin her yerindeki telefon, adres ve sosyal medya bağlantıları buradan gelir.</p></div></div>
    <div class="card"><div class="grid2">${AY.map(([k, l, h]) => `<label class="field"${k === "adres" ? ' style="grid-column:1/-1"' : ""}>${l}${h ? `<small>${h}</small>` : ""}<input data-k="${k}" maxlength="500" value="${esc(A[k])}"></label>`).join("")}</div></div>
    ${savebar()}`;
    el.oninput = (e) => { if (e.target.dataset.k) A[e.target.dataset.k] = e.target.value; };
    el.onclick = (e) => { const t = e.target.closest("[data-save]"); if (t) saveSection("ayarlar", A, t); };
  };

  /* ---------- Mesajlar ---------- */
  VIEWS.mesajlar = (el) => {
    const draw = () => {
      const wa = (t) => "https://wa.me/" + (String(t).replace(/\D/g, "").replace(/^0/, "90").replace(/^(?!90)/, "90"));
      el.innerHTML = `<div class="head"><div><h1>Mesajlar</h1><p class="muted">Sitedeki iletişim formundan gelen talepler. ${unread() ? `<b>${unread()} okunmamış</b>` : "Hepsi okundu."}</p></div></div>
      ${DB.mesajlar.length ? DB.mesajlar.map((m) => `<div class="msg${m.okundu ? "" : " new"}" data-id="${esc(m.id)}"><div class="msg-h"><b>${esc(m.ad)}</b><span class="muted small">${fmtDate(m.tarih)}</span></div>
        <div class="small"><b>${esc(m.telefon)}</b>${m.tur ? ` · <span class="pill">${esc(m.tur)}</span>` : ""}</div>${m.mesaj ? `<p>${esc(m.mesaj)}</p>` : ""}
        <div class="acts"><a class="btn sm" href="tel:${esc(m.telefon.replace(/[^\d+]/g, ""))}">Ara</a><a class="btn sm" href="${esc(wa(m.telefon))}" target="_blank" rel="noopener">WhatsApp</a><button class="btn sm" data-read>${m.okundu ? "Okunmadı yap" : "Okundu yap"}</button><button class="btn sm danger" data-del>Sil</button></div></div>`).join("")
        : `<div class="empty">Henüz mesaj yok. Sitedeki iletişim formundan gelen talepler burada görünür.</div>`}`;
      drawTabs("mesajlar");
    };
    draw();
    el.onclick = async (e) => {
      const row = e.target.closest(".msg"); if (!row) return;
      const m = DB.mesajlar.find((x) => x.id === row.dataset.id);
      try {
        if (e.target.closest("[data-read]")) { Object.assign(m, await api("/api/yonetim/mesajlar/" + m.id, { method: "PUT", body: { okundu: !m.okundu } })); draw(); }
        if (e.target.closest("[data-del]") && (await confirmBox(`${m.ad} kişisinden gelen mesaj silinecek.`))) { await api("/api/yonetim/mesajlar/" + m.id, { method: "DELETE" }); DB.mesajlar = DB.mesajlar.filter((x) => x !== m); draw(); toast("Mesaj silindi"); }
      } catch (er) { fail(er); }
    };
  };

  /* ---------- Ayarlar ---------- */
  VIEWS.ayarlar = (el) => {
    el.innerHTML = `<div class="head"><div><h1>Ayarlar</h1></div></div>
    <div class="grid2">
      <form class="card" id="pwForm"><div class="card-h"><div><h2>Şifre değiştir</h2><p class="muted small">Yeni şifre en az 8 karakter olmalı.</p></div></div>
        <div class="stack"><label class="field">Mevcut şifre<input type="password" id="pwOld" autocomplete="current-password" required></label>
        <label class="field">Yeni şifre<input type="password" id="pwNew" autocomplete="new-password" minlength="8" required></label>
        <label class="field">Yeni şifre (tekrar)<input type="password" id="pwNew2" autocomplete="new-password" minlength="8" required></label>
        <div><button class="btn dark" type="submit">Şifreyi değiştir</button></div></div></form>
      <div class="card"><div class="card-h"><div><h2>Yedekleme</h2><p class="muted small">Tüm site içeriğini (projeler, metinler, mesajlar) tek dosya olarak indirin. Yüklenen fotoğraflar “public/uploads” klasöründedir; onları da ayrıca yedekleyin.</p></div></div>
        <div class="stack"><div><a class="btn" href="/api/yonetim/yedek">Yedeği indir</a></div>
        <div><button class="btn" id="restore">Yedekten geri yükle</button></div><p class="muted small">Geri yükleme mevcut içeriğin yerine geçer.</p></div></div>
    </div>`;
    $("#pwForm").onsubmit = async (e) => {
      e.preventDefault();
      if ($("#pwNew").value !== $("#pwNew2").value) return fail(new Error("Yeni şifreler aynı değil."));
      try { await api("/api/yonetim/sifre", { method: "POST", body: { eski: $("#pwOld").value, yeni: $("#pwNew").value } }); e.target.reset(); toast("Şifre değiştirildi"); } catch (er) { fail(er); }
    };
    $("#restore").onclick = async () => {
      const [f] = await pickFiles("application/json,.json", false); if (!f) return;
      if (!(await confirmBox("Yedekteki içerik mevcut içeriğin yerine geçecek.", "Geri yükle"))) return;
      try { const data = JSON.parse(await f.text()); await api("/api/yonetim/geri-yukle", { method: "POST", body: data }); DB = await api("/api/yonetim/veri"); toast("Yedek geri yüklendi"); route(); }
      catch (er) { fail(er instanceof SyntaxError ? new Error("Dosya okunamadı, geçerli bir yedek değil.") : er); }
    };
  };

  /* ---------- açılış ---------- */
  api("/api/oturum").then((r) => (r.giris ? start() : showLogin())).catch(showLogin);
})();
