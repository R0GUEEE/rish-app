<p align="center">
  <img src="./brand/rish-banner.jpg" alt="Rish — agen dalam saku Anda. Eksekusi lokal. Kebebasan memilih model. DSH / Claude Code / Codex / GLM" width="100%" />
</p>

<h1 align="center">Rish, agen dalam saku Anda.</h1>

<p align="center">
  <strong>Jalankan secara lokal. Pilih model Anda.</strong><br />
  <sub>Ruang kerja lokal · Pilihan model · Eksekusi alat · Persetujuan</sub>
</p>

<p align="center">
  <strong>DSH · Claude Code · Codex · GLM</strong><br />
  <sub>Koneksi bawaan · Adapter Rish native</sub>
</p>

<p align="center">
  <a href="./README.md">简体中文</a> · <a href="./README.en.md">English</a> · <a href="./README.zh-TW.md">繁體中文</a> · <a href="./README.ja.md">日本語</a> · <a href="./README.ko.md">한국어</a> · <a href="./README.fr.md">Français</a> · <a href="./README.es.md">Español</a> · <a href="./README.de.md">Deutsch</a> · <a href="./README.pt.md">Português</a> · <a href="./README.ru.md">Русский</a> · <a href="./README.hi.md">हिन्दी</a> · <a href="./README.tr.md">Türkçe</a> · <a href="./README.th.md">ไทย</a> · <a href="./README.vi.md">Tiếng Việt</a> · <b>Bahasa Indonesia</b>
</p>

<p align="center">
  <a href="#memulai">Memulai</a> ·
  <a href="#koneksi-bawaan">Koneksi bawaan</a> ·
  <a href="#tur-produk">Tur produk</a> ·
  <a href="#platform-dan-model">Platform dan model</a> ·
  <a href="#ekosistem">Ekosistem</a> ·
  <a href="./docs/development.md">Panduan pengembang</a> ·
  <a href="./LICENSE">Lisensi MIT</a>
</p>

Rish menghadirkan percakapan Agent, ruang kerja, dan eksekusi alat ke ponsel Anda.
Pilih model, jelaskan tugas, periksa pekerjaannya, dan setujui perubahan tanpa
harus menjaga komputer tetap menyala. Pemrograman hanyalah salah satu
penggunaannya, bukan satu-satunya tujuannya.

> **Sedang menyiapkan pratinjau sumber eksperimental; belum ada rilis stabil
> yang dapat dipasang.** Cakupan platform dan status verifikasi akun/langganan
> dirangkum dalam [Platform dan model](#platform-dan-model).

## Koneksi bawaan

**Empat koneksi bawaan. Satu ruang kerja dalam saku.**

<table>
<tr>
<td align="center" width="25%">
  <img src="./apps/mobile/src/assets/harness/deepseek-color.svg" alt="DSH / DeepSeek" width="40" height="40" /><br />
  <strong>DSH</strong><br />
  <sub>DeepSeek · Katalog model yang dapat diedit</sub>
</td>
<td align="center" width="25%">
  <img src="./apps/mobile/src/assets/harness/claude-color.svg" alt="Claude Code" width="40" height="40" /><br />
  <strong>Claude Code</strong><br />
  <sub>Anthropic · Kunci API / Masuk dengan langganan¹</sub>
</td>
<td align="center" width="25%">
  <img src="./apps/mobile/src/assets/harness/codex-color.svg" alt="Codex" width="40" height="40" /><br />
  <strong>Codex</strong><br />
  <sub>OpenAI · Kunci API / Masuk dengan langganan¹</sub>
</td>
<td align="center" width="25%">
  <img src="./apps/mobile/src/assets/harness/zai.svg" alt="GLM" width="40" height="40" /><br />
  <strong>GLM</strong><br />
  <sub>Zhipu · Kunci API / Masuk dengan langganan¹</sub>
</td>
</tr>
</table>

¹ Masuk dengan langganan saat ini hanya tersedia di iOS. BigModel Coding Lite telah terverifikasi; Codex dan Claude Code memerlukan build eksperimental opsional. Lihat detail verifikasi di bawah.

Pilih sebuah harness dan hubungkan dengan kunci API atau akun yang didukung
oleh build Anda. Selanjutnya, mulailah bekerja dengan berkas dan proyek di
ponsel Anda. Rish mengelola loop agen, ruang kerja, persetujuan alat, dan
catatan eksekusi; adapter bawaan menyambung ke layanan model.

**Verifikasi akun dan langganan (iOS)**

- **Codex**: build eksperimental opsional telah memverifikasi login perangkat
  melalui CLI resmi, obrolan teks berlangganan `gpt-5.6-luna`, panggilan alat
  `list_dir` lokal, serta persistensi setelah restart. CLI resmi hanya
  digunakan untuk login; tidak semua alat dan model terverifikasi.
- **GLM**: [ZCode](https://zcode.z.ai/en/docs/agents) adalah produk agen dari
  Zhipu; GLM adalah keluarga modelnya. Login BigModel, persistensi setelah
  restart, dan satu respons Coding Lite GLM-5.3 telah terverifikasi; jatah
  uji coba belum. Runtime ZCode resmi belum diintegrasikan.
- **Claude Code**: build eksperimental iOS opsional telah memverifikasi login
  langganan, respons teks Haiku 4.5 melalui CLI resmi tanpa modifikasi, serta
  persistensi setelah restart.
  Jalur ini saat ini hanya mendukung teks, tanpa alat atau lampiran. Satu
  putaran terukur memakan waktu sekitar 4,5 menit; kinerjanya masih perlu
  ditingkatkan.

## Tur produk

Ikuti eksekusi Agent, tinjau perubahan proyek, dan pilih koneksi model.
Klik tangkapan layar untuk membuka berkas aslinya.

<table>
<tr>
<td width="50%" valign="top" align="center">
  <a href="./docs/images/agent-workflow-ios.png"><img src="./docs/images/agent-workflow-ios.png" alt="Percakapan Rish iOS Simulator sungguhan yang memperlihatkan progres, panggilan alat list_dir, dan jawaban akhirnya" width="280" /></a><br />
  <sub><b>Percakapan Agent</b> — Ikuti progres, alat, dan hasil. Teks yang ditampilkan tetap ada setelah aplikasi direstart.</sub>
</td>
<td width="50%" valign="top" align="center">
  <a href="./docs/images/project-changes-ios.png"><img src="./docs/images/project-changes-ios.png" alt="Rish iOS Simulator yang memperlihatkan berkas yang belum di-stage dan statistik perubahan" width="280" /></a><br />
  <sub><b>Proyek lokal</b> — Periksa berkas yang belum di-stage dan statistik perubahan sebelum melakukan commit.</sub>
</td>
</tr>
<tr>
<td colspan="2" valign="top">
  <a href="./docs/images/model-adapters-ipad.png"><img src="./docs/images/model-adapters-ipad.png" alt="Rish iPad Simulator yang memperlihatkan bilah sisi ruang kerja dan empat entri adapter API native" width="100%" /></a><br />
  <sub><b>Ruang kerja iPad dan koneksi model</b> — Bilah sisi layar lebar, tampilan gelap, dan entri adapter API.</sub>
</td>
</tr>
</table>

Semua tangkapan layar berasal dari Simulator sungguhan, memperlihatkan UI dan
alur kerja saat ini.

## Mengapa Rish

<table>
<tr>
<td width="50%">

### Ruang kerja Anda menemani ke mana pun

Simpan berkas dan proyek di ruang kerja milik aplikasi di ponsel. Impor
materi, baca berkas, tinjau perubahan proyek, dan lanjutkan bekerja dalam
satu aplikasi.

</td>
<td width="50%">

### Pilih model Anda

Mulai dari entri bawaan DSH, Claude Code, Codex, dan GLM, atau konfigurasikan
layanan API yang kompatibel beserta pemetaan modelnya. Model mengusulkan
langkah berikutnya; alat lokal yang menjalankan operasinya.

</td>
</tr>
<tr>
<td width="50%">

### Lihat pekerjaan berlangsung

Ikuti teks setiap putaran, penalaran opsional yang dikembalikan penyedia,
panggilan alat, dan hasil akhir. Buka tautan secara langsung dan kembali ke
percakapan tersimpan.

</td>
<td width="50%">

### Tetap dalam kendali

Alat bekerja di dalam ruang kerja yang dibatasi. Operasi yang memerlukan
otorisasi akan meminta izin terlebih dahulu; perubahan berkas dan diff Git
tersedia untuk ditinjau.

</td>
</tr>
</table>

## Gunakan dalam pekerjaan

| Tugas | Titik awal |
| --- | --- |
| Bekerja dengan informasi | Impor teks atau PDF, minta poin-poin pentingnya, lalu tinjau catatan yang disimpan Agent. |
| Mengatur berkas | Periksa direktori proyek, baca berkas tertentu, dan setujui konten baru atau yang diperbarui. |
| Merawat proyek | Tinjau status dan diff Git, edit berkas, dan setujui sebuah commit. |

Contoh-contoh ini memakai kemampuan iOS yang tersedia saat ini. Alat dan
format berkas yang didukung berbeda-beda di tiap platform. Untuk eksperimen
Linux Guest, lihat [referensi runtime](docs/development.md#honest-runtime-boundary).

## Cara kerja eksekusi lokal

```text
Your task → Rish assembles context → Your chosen model service
                                           ↓ Text / tool requests
Phone workspace ← Local tools ← Rish validation and approval
```

Alat yang didukung dieksekusi di lingkungan milik aplikasi di ponsel.
Permintaan model mengirimkan percakapan dan konteks tugas terpilih ke layanan
yang Anda konfigurasikan: **eksekusi lokal tidak berarti inferensi model
secara offline**.

Rish menggabungkan operasi berkas/Git native, runtime Rish, dan Linux Guest
eksperimental. Kompatibilitas penuh dengan program desktop dan eksekusi latar
belakang tanpa batas waktu tidak dijanjikan. [Panduan pengembang](docs/development.md)
memisahkan kemampuan yang terverifikasi dari jalur eksperimental.

## Platform dan model

| Platform | Cakupan saat ini |
| --- | --- |
| iOS / iPadOS | Percakapan native, lampiran, Files, Git, dan alat Agent terkendali; termasuk tata letak iPad adaptif. |
| Android | Obrolan API native, penyimpanan kredensial, pemulihan sesi, dan notifikasi tugas terlingkup. Eksekusi lokal Agent, Files, dan Git belum tersedia. |
| HarmonyOS | Pemeriksaan sementara pada kontainer kompatibilitas Android tidak menetapkan dukungan HarmonyOS native. |

| Koneksi | Metode saat ini |
| --- | --- |
| DeepSeek / DSH | Kunci API dan katalog model yang dapat diedit; kemampuan bergantung pada model dan platform. |
| GLM | Kunci API, ditambah koneksi akun BigModel/Z.ai opsional; lihat status di atas. |
| Codex | Adapter API; build eksperimental iOS opsional menambahkan masuk dengan langganan — lihat status di atas. |
| Claude Code | Adapter API dengan konfigurasi layanan yang kompatibel; panggilan teks berlangganan terverifikasi di build iOS opsional, dengan cakupan dan latensi yang disebutkan di atas. |
| Layanan kustom | Di iOS, pilih Messages, Responses, atau Chat Completions dan konfigurasikan pemetaan model. |

## Memulai

Untuk saat ini bangun dari sumber; belum ada unduhan stabil untuk pengguna
akhir. Setelah Anda mendapatkan kode sumbernya, mulailah dari akar
repositori:

```sh
node scripts/verify-source-checkout.mjs
npm ci --prefix apps/mobile
```

**iOS:** Persiapan native memerlukan versi Xcode, Rust, dan SDK yang
dikunci. Baca [prasyaratnya](docs/development.md#ios-build-prerequisites),
lalu jalankan:

```sh
./scripts/prepare-rish-ios.sh
./scripts/prepare-libgit2-ios.sh
cd apps/mobile/ios
pod install
cd ../../..
npm run ios --prefix apps/mobile
```

**Android:** Dengan lingkungan pengembangan Android yang telah dikonfigurasi,
jalankan `npm run android --prefix apps/mobile`. Panduan pengembang juga
membahas [APK uji mandiri](docs/development.md#install-and-run-the-react-native-app).

Buka aplikasinya, pilih model, dan hubungkan dengan kunci API atau akun yang
didukung. Di iOS, buat atau pilih proyek, tinjau konteksnya, lalu mulai tugas.
Masuk dengan langganan Codex dan Claude Code memerlukan build eksperimental
opsional (lihat [panduan pengembang](docs/development.md)); untuk BigModel,
lihat [panduan akun](docs/zcode-account-login.md). Kredensial tetap tersimpan
di penyimpanan aman native.

## Progres dan kontribusi

Pratinjau sumber pertama sedang disiapkan. Rilis mendatang akan ditandai
**Pre-release**. Kompatibilitas Harness yang lengkap, eksekusi lokal Android,
dan operasi latar belakang berkelanjutan masih terbatas. Lihat
[cakupan pratinjau dan peta jalan](docs/releases/v0.1.0.md).

Kontribusi untuk dokumentasi, dukungan platform, kompatibilitas model, dan
perbaikan yang dapat direproduksi kami nantikan. Baca [CONTRIBUTING](CONTRIBUTING.md)
terlebih dahulu. Untuk masalah keamanan, lihat [SECURITY](SECURITY.md)
sebelum membagikan detail; jangan pernah memposting kredensial atau data
sensitif secara publik.

- [Panduan pengembang dan build](docs/development.md)
- [Merek dan teks yang disetujui](brand/README.md)
- [Pemberitahuan pihak ketiga dan sumber Guest](THIRD_PARTY_NOTICES.md)

Kode proyek dilisensikan di bawah [MIT](LICENSE). Runtime pihak ketiga,
komponen Guest, dan dependensi lainnya tetap memakai lisensi masing-masing.

## Ekosistem

Proyek-proyek serumpun yang dibangun di atas ide lokal-dahulu dan bebas
memilih model yang sama:

- **[rish](https://github.com/ZSeven-W/rish)** — Docker sungguhan di ponsel. Sebuah interpreter full-system x86-64 tanpa JIT dalam Rust murni yang mem-boot Linux dan menjalankan kontainer di iOS dan Android. Linux Guest proyek ini berasal dari sana.
- **[OpenPencil](https://github.com/ZSeven-W/openpencil)** — alat desain vektor AI-native sumber terbuka pertama, dan yang pertama dengan Agent Teams bersamaan. Design-as-Code, mengubah prompt menjadi UI di kanvas langsung.
- **[Jian](https://github.com/ZSeven-W/jian)** — kerangka kerja UI lintas platform yang Rust-native. Sebuah berkas .op adalah sebuah aplikasi.
- **[Zode](https://github.com/ZSeven-W/zode)** — CLI pemrograman AI-native untuk terminal Anda. Mikrokernel plus plugin, multi-penyedia, TUI layar penuh.
- **[Noema](https://github.com/ZSeven-W/noema)** — memori lokal-dahulu untuk agen pemrograman, tanpa penyimpanan vektor, dengan antrean tinjauan dan MCP.
