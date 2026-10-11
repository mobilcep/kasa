/**
 * KASA — küçük esnaf için gelir-gider takip uygulaması.
 *
 * Sunucu : Node.js + Express
 * Port   : yerelde 5055, barındırmada platformun verdiği port
 * Depo   : depo.js (dosya / Redis / bellek — ortama göre otomatik seçilir)
 *
 * PARA MATEMATİĞİ: tüm tutarlar KURUŞ (tam sayı) olarak saklanır ve hesaplanır;
 * bu yüzden 0.1 + 0.2 = 0.3 hatasızdır.
 */

const express = require('express');
const path = require('path');

const { depoSec, dogrula, disaAktar, tlMetin } = require('./depo');

const PORT = process.env.PORT || 5055;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/** Aktif depo (başlatmada seçilir). */
let depo = null;

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

// 1) POST /api/kayit — yeni kayıt
app.post('/api/kayit', async (req, res) => {
  const sonuc = dogrula(req.body);
  if (sonuc.hata) {
    return res.status(400).json({ hata: sonuc.hata });
  }

  const yeni = depo.ekle(sonuc.kayit);
  try {
    await depo.kaydet();
  } catch (hata) {
    console.error('[KASA] Kayıt yazılamadı:', hata.message);
    return res.status(500).json({ hata: 'Kayıt kalıcı olarak yazılamadı' });
  }

  return res.status(201).json(disaAktar(yeni));
});

// 2) GET /api/durum — aktif depo bilgisi (arayüz "veriler kalıcı mı" yazsın)
app.get('/api/durum', (req, res) => {
  res.json({
    depo: depo.ad,
    kalici: depo.kalici,
  });
});

// 3) GET /api/kayitlar — eskiden yeniye
app.get('/api/kayitlar', (req, res) => {
  const sirali = [...depo.tumunuAl()].sort((a, b) => {
    if (a.tarih !== b.tarih) return a.tarih < b.tarih ? -1 : 1;
    return a.id - b.id; // aynı gün: eklenme sırası
  });
  res.json(sirali.map(disaAktar));
});

// 3) GET /api/ozet?ay=YYYY-AA — ay özeti
app.get('/api/ozet', (req, res) => {
  const ay = typeof req.query.ay === 'string' ? req.query.ay.trim() : '';

  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ay)) {
    return res.status(400).json({ hata: 'ay parametresi YYYY-AA biçiminde olmalı' });
  }

  let gelirKurus = 0;
  let giderKurus = 0;
  let adet = 0;
  const kategoriler = {};

  for (const k of depo.tumunuAl()) {
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

async function basla() {
  depo = await depoSec();

  app.listen(PORT, () => {
    console.log('KASA çalışıyor → http://localhost:' + PORT);
    console.log('Depo: ' + depo.ad + ' | Kayıt sayısı: ' + depo.tumunuAl().length);
    if (!depo.kalici) {
      console.warn('[KASA] DİKKAT: aktif depo kalıcı değil — sunucu yeniden başlayınca kayıtlar silinir.');
    }
  });
}

basla().catch((hata) => {
  console.error('[KASA] Başlatılamadı:', hata);
  process.exit(1);
});
