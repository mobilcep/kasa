/**
 * KASA — kalıcı depo katmanı.
 *
 * Nerede çalıştığına göre üç farklı arka uç kullanır:
 *   1) Redis (REDIS_URL varsa)   → Vercel/Netlify gibi kalıcı diski olmayan ortamlar
 *   2) Dosya (kasa.json)         → yerel çalıştırma, veri diskte durur
 *   3) Bellek                    → son çare (yalnız çalışma süresi boyunca yaşar)
 *
 * Böylece hem "npm start" ile yerelde kalıcı çalışır, hem canlıda veri kaybolmaz.
 */

const fs = require('fs');
const path = require('path');

const DOSYA_YOLU = process.env.KASA_VERI || path.join(__dirname, 'kasa.json');

/* ------------------------------------------------------------------ */
/* Yardımcılar                                                         */
/* ------------------------------------------------------------------ */

/** Kullanıcıdan gelen tutarı kuruş (tam sayı) cinsine çevirir. */
function kurusaCevir(deger) {
  const sayi =
    typeof deger === 'number' ? deger : Number(String(deger).replace(',', '.'));
  if (!Number.isFinite(sayi)) return null;
  return Math.round(sayi * 100);
}

/** Kuruşu okunabilir TL metnine çevirir. */
function tlMetin(kurus) {
  return (kurus / 100).toFixed(2);
}

/* ------------------------------------------------------------------ */
/* Normalizasyon — kayıt hangi şemadan gelirse gelsin tek biçime iner  */
/* ------------------------------------------------------------------ */

/**
 * Ham bir kaydı iç biçime çevirir.
 * İKİ ŞEMA DESTEKLENİR (eski dosyalar bozulmasın):
 *   1) { tutarKurus: 150050 }
 *   2) { tutar: 1500.5 }  (TL cinsinden, eski/dış şema)
 */
function kayitNormalize(k, i) {
  let tutarKurus;
  if (Number.isFinite(k.tutarKurus)) {
    tutarKurus = Math.round(k.tutarKurus);
  } else if (k.tutar !== undefined && k.tutar !== null) {
    tutarKurus = kurusaCevir(k.tutar);
  } else {
    tutarKurus = 0;
  }
  if (!Number.isFinite(tutarKurus)) tutarKurus = 0;

  return {
    id: Number.isInteger(k.id) ? k.id : i + 1,
    tur: k.tur === 'gider' ? 'gider' : 'gelir',
    tutarKurus,
    aciklama: typeof k.aciklama === 'string' ? k.aciklama : '',
    tarih: typeof k.tarih === 'string' ? k.tarih : '',
    kategori:
      typeof k.kategori === 'string' && k.kategori.trim() ? k.kategori : 'Genel',
  };
}

/** Kayıt listesini iç biçime çevirir. */
function listeNormalize(liste) {
  return (Array.isArray(liste) ? liste : []).map(kayitNormalize);
}

/** Depodaki kaydı API çıktısına çevirir (tutar asla null olmaz). */
function disaAktar(k) {
  const kurus = Number.isFinite(k.tutarKurus) ? k.tutarKurus : 0;
  return {
    id: k.id,
    tur: k.tur,
    tutar: Number(tlMetin(kurus)),
    aciklama: k.aciklama,
    tarih: k.tarih,
    kategori: k.kategori,
  };
}

/* ------------------------------------------------------------------ */
/* Dosya arka ucu                                                      */
/* ------------------------------------------------------------------ */

function dosyaDepo() {
  let kayitlar = [];
  let sonId = 0;

  return {
    ad: 'dosya (' + DOSYA_YOLU + ')',
    kalici: true,

    async yukle() {
      try {
        if (!fs.existsSync(DOSYA_YOLU)) {
          kayitlar = [];
          sonId = 0;
          return;
        }
        const ham = fs.readFileSync(DOSYA_YOLU, 'utf8');
        if (!ham.trim()) {
          kayitlar = [];
          sonId = 0;
          return;
        }
        const veri = JSON.parse(ham);
        const liste = Array.isArray(veri) ? veri : veri.kayitlar;

        kayitlar = listeNormalize(liste);
        sonId = Number.isInteger(veri.sonId)
          ? veri.sonId
          : kayitlar.reduce((m, k) => Math.max(m, k.id), 0);
      } catch (hata) {
        console.error('[KASA] Veri dosyası okunamadı, boş başlanıyor:', hata.message);
        kayitlar = [];
        sonId = 0;
      }
    },

    async kaydet() {
      const icerik = JSON.stringify({ sonId, kayitlar }, null, 2);
      const gecici = DOSYA_YOLU + '.tmp';
      fs.writeFileSync(gecici, icerik, 'utf8');
      fs.renameSync(gecici, DOSYA_YOLU); // atomik: yarım dosya kalmaz
    },

    tumunuAl() {
      return kayitlar;
    },

    ekle(kayit) {
      sonId += 1;
      const yeni = Object.assign({ id: sonId }, kayit);
      kayitlar.push(yeni);
      return yeni;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Bellek arka ucu (yalnız çalışma süresi boyunca yaşar)               */
/* ------------------------------------------------------------------ */

function bellekDepo() {
  let kayitlar = [];
  let sonId = 0;

  return {
    ad: 'bellek (KALICI DEĞİL)',
    kalici: false,

    async yukle() {},
    async kaydet() {},

    tumunuAl() {
      return kayitlar;
    },

    ekle(kayit) {
      sonId += 1;
      const yeni = Object.assign({ id: sonId }, kayit);
      kayitlar.push(yeni);
      return yeni;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Redis arka ucu (yönetilen barındırma ortamları için)                */
/* ------------------------------------------------------------------ */

async function redisDepo(url) {
  // redis paketi opsiyoneldir: yalnız REDIS_URL verilince yüklenir.
  let createClient;
  try {
    ({ createClient } = require('redis'));
  } catch (e) {
    console.warn('[KASA] REDIS_URL verildi ama "redis" paketi kurulu değil — belleğe düşülüyor.');
    return null;
  }

  const ANAHTAR = 'kasa:kayitlar';
  const istemci = createClient({ url });
  istemci.on('error', (e) => console.error('[KASA] Redis hatası:', e.message));

  try {
    await istemci.connect();
  } catch (e) {
    console.warn('[KASA] Redis bağlantısı kurulamadı — belleğe düşülüyor:', e.message);
    return null;
  }

  let kayitlar = [];
  let sonId = 0;

  return {
    ad: 'redis',
    kalici: true,

    async yukle() {
      try {
        const ham = await istemci.get(ANAHTAR);
        if (!ham) return;
        const veri = JSON.parse(ham);
        kayitlar = listeNormalize(veri.kayitlar);
        sonId = Number.isInteger(veri.sonId)
          ? veri.sonId
          : kayitlar.reduce((m, k) => Math.max(m, k.id), 0);
      } catch (hata) {
        console.error('[KASA] Redis okuma hatası:', hata.message);
      }
    },

    async kaydet() {
      await istemci.set(ANAHTAR, JSON.stringify({ sonId, kayitlar }));
    },

    tumunuAl() {
      return kayitlar;
    },

    ekle(kayit) {
      sonId += 1;
      const yeni = Object.assign({ id: sonId }, kayit);
      kayitlar.push(yeni);
      return yeni;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Seçim                                                               */
/* ------------------------------------------------------------------ */

/**
 * Ortama uygun depoyu seçer ve yükler.
 * Vercel gibi salt-okunur dosya sistemli ortamlarda diske yazmaya çalışmak
 * hata verir; bu yüzden orada dosya arka ucu yerine Redis/bellek kullanılır.
 */
async function depoSec() {
  if (process.env.REDIS_URL) {
    const r = await redisDepo(process.env.REDIS_URL);
    if (r) {
      await r.yukle();
      return r;
    }
  }

  // Vercel/AWS Lambda gibi ortamlarda dosya sistemi kalıcı değildir.
  const yonetilenOrtam = Boolean(
    process.env.VERCEL || process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME
  );

  if (yonetilenOrtam) {
    const b = bellekDepo();
    await b.yukle();
    console.warn(
      '[KASA] Yönetilen ortam algılandı (VERCEL/NETLIFY) — kalıcı depo için REDIS_URL tanımlayın.'
    );
    return b;
  }

  const d = dosyaDepo();
  await d.yukle();
  return d;
}

/* ------------------------------------------------------------------ */
/* Doğrulama                                                           */
/* ------------------------------------------------------------------ */

const TARIH_DESENI = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Tarihin gerçekten var olan bir takvim günü olup olmadığını kontrol eder. */
function tarihGecerliMi(metin) {
  if (typeof metin !== 'string') return false;
  const e = TARIH_DESENI.exec(metin.trim());
  if (!e) return false;

  const yil = Number(e[1]);
  const ay = Number(e[2]);
  const gun = Number(e[3]);
  if (ay < 1 || ay > 12) return false;
  if (gun < 1 || gun > 31) return false;

  const d = new Date(Date.UTC(yil, ay - 1, gun));
  return (
    d.getUTCFullYear() === yil &&
    d.getUTCMonth() === ay - 1 &&
    d.getUTCDate() === gun
  );
}

/** Kayıt gövdesini doğrular: { kayit } ya da { hata }. */
function dogrula(govde) {
  const g = govde && typeof govde === 'object' ? govde : {};

  if (g.tur !== 'gelir' && g.tur !== 'gider') {
    return { hata: 'tur yalnızca "gelir" ya da "gider" olabilir' };
  }

  const hamTutar = g.tutar;
  const tutarSayi =
    typeof hamTutar === 'number'
      ? hamTutar
      : typeof hamTutar === 'string' && hamTutar.trim() !== ''
      ? Number(hamTutar.trim().replace(',', '.'))
      : NaN;

  if (!Number.isFinite(tutarSayi)) {
    return { hata: 'tutar geçerli bir sayı olmalı' };
  }
  if (tutarSayi <= 0) {
    return { hata: "tutar 0'dan büyük olmalı" };
  }
  const ondalikMetin = String(tutarSayi);
  if (ondalikMetin.includes('e') || ondalikMetin.includes('E')) {
    return { hata: 'tutar en fazla 2 ondalık basamak içerebilir' };
  }
  const nokta = ondalikMetin.indexOf('.');
  if (nokta !== -1 && ondalikMetin.length - nokta - 1 > 2) {
    return { hata: 'tutar en fazla 2 ondalık basamak içerebilir' };
  }

  if (typeof g.aciklama !== 'string' || g.aciklama.trim() === '') {
    return { hata: 'aciklama boş olamaz' };
  }
  const aciklama = g.aciklama.trim();
  if (aciklama.length > 200) {
    return { hata: 'aciklama en fazla 200 karakter olabilir' };
  }

  if (!tarihGecerliMi(g.tarih)) {
    return { hata: 'tarih geçerli bir takvim günü olmalı (YYYY-AA-GG)' };
  }
  const tarih = String(g.tarih).trim();

  let kategori = 'Genel';
  if (typeof g.kategori === 'string' && g.kategori.trim() !== '') {
    kategori = g.kategori.trim();
  } else if (
    g.kategori !== undefined &&
    g.kategori !== null &&
    typeof g.kategori !== 'string'
  ) {
    return { hata: 'kategori metin olmalı' };
  }
  if (kategori.length > 60) {
    return { hata: 'kategori en fazla 60 karakter olabilir' };
  }

  return {
    kayit: {
      tur: g.tur,
      tutarKurus: Math.round(tutarSayi * 100),
      aciklama,
      tarih,
      kategori,
    },
  };
}

module.exports = {
  depoSec,
  dogrula,
  disaAktar,
  kurusaCevir,
  tlMetin,
  tarihGecerliMi,
};
