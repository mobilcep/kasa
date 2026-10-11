# KASA

Küçük esnaf için günlük **gelir–gider takip** uygulaması. Kendi kasanızı tutun: kayıtları girin, ay bazında gelir/gider/net görün.

## Kurulum ve çalıştırma

```bash
npm install
npm start
```

Ardından tarayıcıdan **http://localhost:5055** adresini açın.

- Kurulum komutu: `npm install`
- Başlatma komutu: `npm start` (port 5055)

## Ne yapar

- **Kayıt ekleme:** gelir/gider, tutar, açıklama, tarih ve kategori
- **Kayıt listesi:** eskiden yeniye sıralı
- **Ay özeti:** seçilen ayın gelir, gider ve net toplamı + kategori dökümü

## Para matematiği

Tutarlar kayan noktalı sayı olarak değil, **kuruş (tam sayı)** olarak saklanır ve hesaplanır. Bu yüzden `0.1 + 0.2` toplamı `0.30000000000000004` değil, tam olarak **0.3** çıkar — kuruş hatası olmaz.

## Verilerin saklanması

Kayıtlar çalıştığınız ortama göre üç yoldan biriyle saklanır:

| Ortam | Depo | Kalıcı mı? |
|---|---|---|
| Yerel (`npm start`) | `kasa.json` dosyası | ✅ Kalıcı |
| Sunucu (Vercel/Netlify) + `REDIS_URL` | Redis | ✅ Kalıcı |
| Sunucu, `REDIS_URL` yok | Bellek | ⚠️ Çalışma süresi boyunca |

> **Not:** Vercel gibi platformlarda dosya sistemi kalıcı değildir. Canlıda verilerin kaybolmaması için bir Redis bağlantısı (`REDIS_URL` ortam değişkeni) tanımlanmalıdır. Tanımlanmazsa uygulama yine çalışır, ancak kayıtlar yeniden başlatmada silinir.

Ek olarak `kasa.json` içindeki eski şemalı kayıtlar (`tutar` alanı, TL cinsinden) otomatik olarak yeni şemaya (`tutarKurus`) çevrilir; mevcut veriler bozulmaz.

## API

### `POST /api/kayit`

Yeni kayıt ekler.

```json
{
  "tur": "gelir",
  "tutar": 1500.50,
  "aciklama": "Günlük yevmiye",
  "tarih": "2026-10-05",
  "kategori": "Satış"
}
```

Kurallar:

- `tur` yalnızca `"gelir"` ya da `"gider"` olabilir
- `tutar` 0'dan büyük ve en fazla 2 ondalık basamaklı olmalı
- `aciklama` boş olamaz, en fazla 200 karakter
- `tarih` gerçek bir takvim günü olmalı (`2026-02-30` geçersizdir)
- `kategori` boş bırakılırsa `"Genel"` kabul edilir

Başarılıysa **201** ve oluşan kayıt (otomatik `id` ile) döner.
Geçersizse **400** ve `{ "hata": "neden" }` döner.

### `GET /api/kayitlar`

Tüm kayıtları tarihe göre **eskiden yeniye** döndürür.

### `GET /api/ozet?ay=YYYY-AA`

Seçilen ayın özetini döndürür:

```json
{
  "gelir": 1500.50,
  "gider": 200.00,
  "net": 1300.50,
  "kayitSayisi": 4,
  "kategoriler": {
    "Satış": { "gelir": 1500.50, "gider": 0 },
    "Genel": { "gelir": 0, "gider": 200.00 }
  }
}
```

Kaydı olmayan bir ay için tüm toplamlar `0`, `kategoriler` ise boş nesne (`{}`) döner.

## Proje yapısı

```
├── server.js        # HTTP sunucusu + API uçları
├── depo.js          # Kalıcı depo katmanı (dosya / Redis / bellek) + doğrulama
├── public/
│   └── index.html   # Türkçe arayüz (form + liste + ay özeti)
├── kasa.json        # Veri dosyası (yerelde; git'e girmez)
├── BASLAT.txt       # Başlatma komutu
├── KURULUM.txt      # Kurulum komutu
└── vercel.json      # Vercel yapılandırması
```
