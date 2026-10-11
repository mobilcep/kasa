/**
 * KASA — küçük esnaf için gelir-gider takip uygulaması
 * Sunucu: Node.js + Express (port 5055)
 * Kalıcı veri: kasa.json (sunucu yeniden başlatılınca kaybolmaz)
 *
 * PARA MATEMATİĞİ: Tüm tutarlar KURUŞ (tam sayı) olarak saklanır ve hesaplanır.
 * Böylece 0.1 + 0.2 = 0.30000000000000004 gibi kayan nokta hatası oluşmaz.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

// Yerelde 5055; barındırma (deploy) ortamlarında platformun verdiği port kullanılır.
const PORT = process.env.PORT || 5055;
const VERI_DOSYASI = process.env.KASA_VERI || path.join(__dirname, 'kasa.json');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------------------ */
/* Kalıcı depo                                                         */
/* ------------------------------------------------------------------ */

let kayitlar = [];
let sonId = 0;

/**
 * Diskteki kasa.json dosyasını okur. Dosya yoksa/bozuksa boş listeyle başlar.
 */
function veriYukle() {
  try {
    if (!fs.existsSync(VERI_DOSYASI)) {
      kayitlar = [];
      sonId = 0;
      return;
    }
    const ham = fs.readFileSync(VERI_DOSYASI, 'utf8');
    if (!ham.trim()) {
      kayitlar = [];
      sonId = 0;
      return;
    }
    const veri = JSON.parse(ham);
    const liste = Array.isArray(veri) ? veri : veri.kayitlar;

    // Diskteki veriyi normalize et.
    // İKİ ŞEMA DESTEKLENİR:
    //   1) Bu sürümün şeması  : { tutarKurus: 150050 }
    //   2) Eski/dış şema      : { tutar: 1500.5 }  (TL cinsinden)
    // Eski şemadaki kayıtlarda tutarKurus bulunmadığı için kurusaCevir(undefined)
    // null dönüyor ve API "tutar": null veriyordu → arayüzde 0,00 görünüyordu.
    kayitlar = (Array.isArray(liste) ? liste : []).map((k, i) => {
      let tutarKurus;
      if (Number.isFinite(k.tutarKurus)) {
        tutarKurus = Math.round(k.tutarKurus);
      } else if (k.tutar !== undefined && k.tutar !== null) {
        tutarKurus = kurusaCevir(k.tutar); // eski şema: TL → kuruş
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
        kategori: typeof k.kategori === 'string' && k.kategori.trim() ? k.kategori : 'Genel',
      };
    });

    sonId = Number.isInteger(veri.sonId)
      ? veri.sonId
      : kayitlar.reduce((maks, k) => Math.max(maks, k.id), 0);
  } catch (hata) {
    console.error('[KASA] kasa.json okunamadı, boş listeyle başlanıyor:', hata.message);
    kayitlar = [];
    sonId = 0;
  }
}

/**
 * Kayıtları diske yazar (atomik: önce .tmp, sonra rename).
 */
function veriKaydet() {
  const icerik = JSON.stringify({ sonId, kayitlar }, null, 2);
  const gecici = VERI_DOSYASI + '.tmp';
  fs.writeFileSync(gecici, icerik, 'utf8');
  fs.renameSync(gecici, VERI_DOSYASI);
}

/* ------------------------------------------------------------------ */
/* Para yardımcıları (kuruş tabanlı)                                   */
/* ------------------------------------------------------------------ */

/**
 * Kullanıcıdan gelen tutarı kuruş (tam sayı) cinsine çevirir.
 * Geçersizse null döner.
 */
function kurusaCevir(deger) {
  const sayi = typeof deger === 'number' ? deger : Number(String(deger).replace(',', '.'));
  if (!Number.isFinite(sayi)) return null;
  return Math.round(sayi * 100);
}

/** Kuruşu okunabilir TL metnine çevirir. */
function tlMetin(kurus) {
  return (kurus / 100).toFixed(2);
}

/* ------------------------------------------------------------------ */
/* Doğrulama                                                           */
/* ------------------------------------------------------------------ */

const TARIH_DESENI = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Tarihin gerçekten var olan bir takvim günü olup olmadığını kontrol eder.
 * 2026-02-30 gibi taşan tarihler geçersizdir.
 */
function tarihGecerliMi(metin) {
  if (typeof metin !== 'string') return false;
  const eslesme = TARIH_DESENI.exec(metin.trim());
  if (!eslesme) return false;

  const yil = Number(eslesme[1]);
  const ay = Number(eslesme[2]);
  const gun = Number(eslesme[3]);
  if (ay < 1 || ay > 12) return false;
  if (gun < 1 || gun > 31) return false;

  // Date nesnesi taşan günü bir sonraki aya kaydırır; karşılaştırma yakalar.
  const d = new Date(Date.UTC(yil, ay - 1, gun));
  return (
    d.getUTCFullYear() === yil &&
    d.getUTCMonth() === ay - 1 &&
    d.getUTCDate() === gun
  );
}

/**
 * Kayıt gövdesini doğrular. Geçerliyse { kayit }, geçersizse { hata } döner.
 */
function dogrula(govde) {
  const g = govde && typeof govde === 'object' ? govde : {};

  // tur
  if (g.tur !== 'gelir' && g.tur !== 'gider') {
    return { hata: 'tur yalnızca "gelir" ya da "gider" olabilir' };
  }

  // tutar — sayı, 0'dan büyük, en fazla 2 ondalık basamak
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
    return { hata: 'tutar 0\'dan büyük olmalı' };
  }
  // Ondalık basamak kontrolü: metinsel gösteriminde en fazla 2 hane.
  const ondalikMetin = String(tutarSayi);
  if (ondalikMetin.includes('e') || ondalikMetin.includes('E')) {
    return { hata: 'tutar en fazla 2 ondalık basamak içerebilir' };
  }
  const noktaIndex = ondalikMetin.indexOf('.');
  if (noktaIndex !== -1 && ondalikMetin.length - noktaIndex - 1 > 2) {
    return { hata: 'tutar en fazla 2 ondalık basamak içerebilir' };
  }

  const tutarKurus = Math.round(tutarSayi * 100);

  // aciklama — zorunlu, en fazla 200 karakter
  if (typeof g.aciklama !== 'string' || g.aciklama.trim() === '') {
    return { hata: 'aciklama boş olamaz' };
  }
  const aciklama = g.aciklama.trim();
  if (aciklama.length > 200) {
    return { hata: 'aciklama en fazla 200 karakter olabilir' };
  }

  // tarih — geçerli takvim günü
  if (!tarihGecerliMi(g.tarih)) {
    return { hata: 'tarih geçerli bir takvim günü olmalı (YYYY-AA-GG)' };
  }
  const tarih = String(g.tarih).trim();

  // kategori — boşsa "Genel"
  let kategori = 'Genel';
  if (typeof g.kategori === 'string' && g.kategori.trim() !== '') {
    kategori = g.kategori.trim();
  } else if (g.kategori !== undefined && g.kategori !== null && typeof g.kategori !== 'string') {
    return { hata: 'kategori metin olmalı' };
  }
  if (kategori.length > 60) {
    return { hata: 'kategori en fazla 60 karakter olabilir' };
  }

  return {
    kayit: {
      tur: g.tur,
      tutarKurus,
      aciklama,
      tarih,
      kategori,
    },
  };
}

/** Depodaki kaydı API çıktısına çevirir. */
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
/* API                                                                 */
/* ------------------------------------------------------------------ */

// 1) POST /api/kayit
app.post('/api/kayit', (req, res) => {
  const sonuc = dogrula(req.body);
  if (sonuc.hata) {
    return res.status(400).json({ hata: sonuc.hata });
  }

  sonId += 1;
  const yeni = {
    id: sonId,
    tur: sonuc.kayit.tur,
    tutarKurus: sonuc.kayit.tutarKurus,
    aciklama: sonuc.kayit.aciklama,
    tarih: sonuc.kayit.tarih,
    kategori: sonuc.kayit.kategori,
  };

  kayitlar.push(yeni);
  veriKaydet();

  return res.status(201).json(disaAktar(yeni));
});

// 2) GET /api/kayitlar — eskiden yeniye
app.get('/api/kayitlar', (req, res) => {
  const sirali = [...kayitlar].sort((a, b) => {
    if (a.tarih !== b.tarih) return a.tarih < b.tarih ? -1 : 1;
    return a.id - b.id; // aynı gün: eklenme sırası
  });
  res.json(sirali.map(disaAktar));
});

// 3) GET /api/ozet?ay=YYYY-AA
app.get('/api/ozet', (req, res) => {
  const ay = typeof req.query.ay === 'string' ? req.query.ay.trim() : '';

  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ay)) {
    return res.status(400).json({ hata: 'ay parametresi YYYY-AA biçiminde olmalı' });
  }

  let gelirKurus = 0;
  let giderKurus = 0;
  let adet = 0;
  const kategoriler = {};

  for (const k of kayitlar) {
    if (!k.tarih.startsWith(ay)) continue;

    adet += 1;
    if (!kategoriler[k.kategori]) {
      kategoriler[k.kategori] = { gelirKurus: 0, giderKurus: 0 };
    }

    const kurus = Number.isFinite(k.tutarKurus) ? k.tutarKurus : 0;

    if (k.tur === 'gelir') {
      gelirKurus += kurus;
      kategoriler[k.kategori].gelirKurus += kurus;
    } else {
      giderKurus += kurus;
      kategoriler[k.kategori].giderKurus += kurus;
    }
  }

  const kategorilerCikti = {};
  for (const ad of Object.keys(kategoriler).sort((a, b) => a.localeCompare(b, 'tr'))) {
    kategorilerCikti[ad] = {
      gelir: Number(tlMetin(kategoriler[ad].gelirKurus)),
      gider: Number(tlMetin(kategoriler[ad].giderKurus)),
    };
  }

  res.json({
    gelir: Number(tlMetin(gelirKurus)),
    gider: Number(tlMetin(giderKurus)),
    net: Number(tlMetin(gelirKurus - giderKurus)),
    kayitSayisi: adet,
    kategoriler: kategorilerCikti,
  });
});

/* ------------------------------------------------------------------ */
/* Başlatma                                                            */
/* ------------------------------------------------------------------ */

veriYukle();

app.listen(PORT, () => {
  console.log('KASA çalışıyor → http://localhost:' + PORT);
  console.log('Kayıt sayısı: ' + kayitlar.length + ' | Veri dosyası: kasa.json');
});
