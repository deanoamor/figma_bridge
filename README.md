# Figma Bridge (Claude Bridge)

Plugin Figma + server MCP yang membuat **Claude bisa mendesain langsung di Figma**. Dibuat untuk pemakaian pribadi di komputer sendiri, memakai langganan Claude yang sudah ada (tidak perlu API key).

```
Claude Desktop / Claude Code
        │  MCP (stdio)
        ▼
  server/index.js  ──WebSocket (localhost:3055)──►  Plugin Figma (plugin/)
                                                          │
                                                          ▼
                                                    Figma Plugin API
```

Server hanya mendengarkan di `127.0.0.1`, jadi tidak terbuka ke jaringan.

## Fitur

- **Buat dan ubah desain**: frame, teks, shape, auto layout, gradient, shadow, sudut bulat, struktur bertingkat dalam satu perintah.
- **Fill gambar**: dari file di komputer, URL, atau salin dari node lain.
- **Animasi build**: desain muncul bertahap seperti digambar langsung.
- **Dua slot (Sumber → Target)**: pilih desain berisi informasi dan desain yang mau diubah, lalu beri brief lewat Claude.
- **Claude bisa melihat hasilnya**: ekspor node jadi gambar, lalu memperbaiki sendiri.

## Isi

- [Prasyarat](#prasyarat)
- [Tutorial pemasangan](#tutorial-pemasangan)
- [Cara pakai](#cara-pakai)
- [Referensi tool](#referensi-tool)
- [Mematikan dan memperbarui](#mematikan-dan-memperbarui)
- [Pemecahan masalah](#pemecahan-masalah)
- [Pengembangan dan tes](#pengembangan-dan-tes)
- [Catatan keamanan](#catatan-keamanan)

## Prasyarat

- **Node.js 18 atau lebih baru** (cek dengan `node -v`)
- **Aplikasi desktop Figma**. Plugin development tidak bisa dijalankan dari Figma di browser.
- **Claude Desktop** atau **Claude Code** (salah satu cukup)

## Tutorial pemasangan

### 1. Ambil kode dan pasang dependensi

```bash
git clone https://github.com/deanoamor/figma_bridge.git
cd figma_bridge
npm install
```

Pesan `npm audit` atau "new major version of npm" setelah `npm install` boleh diabaikan. Jangan jalankan `npm audit fix --force`.

Catat **path lengkap** ke `server/index.js`, misalnya `D:/figma_bridge/server/index.js`. Di Windows, tulis dengan garis miring `/` supaya tidak perlu menggandakan backslash.

### 2. Daftarkan server MCP ke Claude

Pilih salah satu.

**Claude Desktop**

1. Buka **Settings → Developer → Edit Config**. File `claude_desktop_config.json` akan terbuka.
2. Tambahkan blok `figma-bridge` (jika `mcpServers` sudah ada isinya, tambahkan saja di dalamnya):

```json
{
  "mcpServers": {
    "figma-bridge": {
      "command": "node",
      "args": ["D:/figma_bridge/server/index.js"]
    }
  }
}
```

3. Simpan, lalu **tutup Claude Desktop sepenuhnya**, termasuk dari system tray (klik kanan ikonnya → Quit), dan buka lagi.
4. Cek di **Settings → Developer**: `figma-bridge` harus berstatus *running*.

**Claude Code**

```bash
claude mcp add figma-bridge -- node D:/figma_bridge/server/index.js
```

Ganti path sesuai lokasi kamu. Kalau perintah `claude` tidak dikenali, pasang dulu: `npm install -g @anthropic-ai/claude-code`.

### 3. Impor plugin ke Figma

1. Buka aplikasi desktop Figma dan sebuah **file Design** (bukan FigJam).
2. Menu **Plugins → Development → Import plugin from manifest...**
3. Pilih `plugin/manifest.json` dari folder proyek ini.

Impor cukup dilakukan sekali. Plugin tetap ada di menu Plugins → Development.

### 4. Jalankan dan tes

1. Di Figma: **Plugins → Development → Claude Bridge**. Jendela kecil muncul dengan titik **hijau** dan tulisan "Connected to Claude". **Biarkan jendela ini terbuka** selama Claude bekerja. Kalau ditutup, koneksi putus.
2. Di chat Claude (satu chat saja), ketik:

> Pakai figma_status untuk cek koneksi, lalu buat kartu profil sederhana 320x200 dengan nama dan tombol.

Kalau kartunya muncul di kanvas Figma, semuanya sudah jalan.

## Cara pakai

Claude bekerja lewat tool `figma_*`. Kamu cukup menulis brief biasa. Beberapa pola yang berguna:

### Membuat desain dari nol

> Buat halaman dashboard web profesional di Figma, frame 1440x1024. Sidebar kiri 240px, header dengan pencarian, 4 kartu KPI, grafik garis, dan tabel pesanan terbaru. Warna latar #F6F7F9, aksen #4F46E5, font Inter. Pakai auto layout, beri nama layer yang jelas, dan cek hasilnya dengan figma_export setelah tiap bagian besar.

Tips: minta Claude membangun satu layar dalam **satu** panggilan `figma_create` dengan children bertingkat, lalu memeriksa dan memperbaikinya. Kalau hasilnya kurang pas, minta perbaikan spesifik ("jarak antar KPI terlalu rapat") dan jangan mengulang dari awal.

### Dua slot: buat desain baru dari informasi yang ada

Untuk kasus "ada desain berisi informasi, lalu bikin desain baru dari informasi itu".

1. Pilih desain berisi informasi, lalu klik **Pakai seleksi** di baris *1 · Sumber informasi* pada jendela plugin.
2. Pilih desain yang mau diubah (template, poster, kartu, dsb.), lalu klik **Pakai seleksi** di baris *2 · Target desain*.
3. Tulis brief ke Claude, misalnya:

> Isi target dengan informasi dari sumber. Judul dan 3 poin utama saja, gaya lebih minimalis, warna brand jangan diubah.

Claude membaca isi sumber (teks berurutan dari atas ke bawah, gambar, struktur) dan struktur target, **menggandakan target dulu** supaya aslinya aman (kecuali kamu minta ubah langsung), mengisi teks lewat id node (gaya font tetap terjaga), menambah atau menghapus baris bila jumlah item berbeda, lalu mengecek hasilnya dengan screenshot. Claude tidak mengarang informasi yang tidak ada di sumber dan melaporkan bagian yang tidak muat.

Satu slot bisa berisi beberapa node. Slot tersimpan di file Figma, jadi tetap ada saat plugin dibuka ulang.

### Fill gambar

Rectangle, ellipse, dan frame bisa diberi gambar sebagai fill, saat dibuat maupun lewat `figma_update` untuk mengganti gambar.

| Sumber | Contoh |
|---|---|
| `path` | file di komputer: `D:/foto/sepatu.png` |
| `url` | `https://contoh.com/foto.jpg` |
| `fromNodeId` | pakai ulang gambar dari node lain di Figma |

`scaleMode`: `FILL` (default), `FIT`, `CROP`, `TILE`. Format PNG, JPEG, GIF, maksimal 12 MB (ubah dengan variabel lingkungan `FIGMA_BRIDGE_MAX_IMAGE_MB`). WebP dan SVG harus dikonversi dulu. Gambar bisa ditumpuk dengan fill lain, misalnya gradient gelap di atas foto.

> Buat kartu produk 320x420. Di bagian atas ada foto dari D:/foto/sepatu.png (tinggi 240, sudut atas 16, mode FILL), lalu nama produk, harga, dan tombol Beli di bawahnya.

### Animasi build

Saat Claude membuat desain, node dimunculkan satu per satu dengan fade-in dari wadah ke isinya, sambil kanvas zoom ke area yang dibangun.

- Aktif/nonaktif dan kecepatan (Cepat / Normal / Lambat) diatur di jendela plugin dan diingat antar sesi.
- Claude bisa menimpanya per panggilan (`animate`, `speed`), misalnya `animate: false` untuk edit massal.
- Total animasi dibatasi sekitar 12 detik, jadi desain besar dipercepat otomatis.
- Setelah selesai, semua node kembali ke opacity aslinya.

## Referensi tool

| Tool | Fungsi |
|---|---|
| `figma_status` | Cek koneksi, nama file, halaman, jumlah seleksi |
| `figma_get_selection` | Baca node yang sedang dipilih |
| `figma_list_variables` | Daftar collection dan variable lokal di file (hanya baca) |
| `figma_get_node` | Baca node (atau halaman) berdasarkan id |
| `figma_get_slots` | Baca slot Sumber dan Target (teks berurutan, gambar, struktur) |
| `figma_set_slot` | Isi atau kosongkan slot (dari id atau seleksi saat ini) |
| `figma_create` | Buat node, boleh bertingkat (auto layout, teks, gradient, shadow, gambar) |
| `figma_update` | Ubah properti node, atau pindahkan ke parent lain |
| `figma_delete` | Hapus node (bisa di-undo di Figma) |
| `figma_clone` | Duplikat node |
| `figma_select` | Pilih node dan zoom ke sana |
| `figma_export` | Ekspor node jadi gambar supaya Claude bisa melihat hasilnya |

Properti node yang didukung (ringkas): `type` (FRAME, RECTANGLE, ELLIPSE, TEXT, LINE, POLYGON, STAR), `name`, `x`, `y`, `width`, `height`, `rotation`, `opacity`, `fills`, `strokes`, `cornerRadius`, `effects`, auto layout (`layoutMode`, `itemSpacing`, `padding`, `primaryAxisAlignItems`, `layoutSizingHorizontal` dst.), teks (`characters`, `fontSize`, `fontFamily`, `fontStyle`, `lineHeight`, `letterSpacing`, `textAlignHorizontal`), dan `children`. Daftar lengkap ada di deskripsi tool `figma_create`.

## Mematikan dan memperbarui

**Mematikan**

1. Tutup jendela **Claude Bridge** di Figma (tombol X). Claude tidak bisa lagi mengubah file Figma-mu.
2. Server MCP berjalan bersama Claude Desktop dan berhenti saat aplikasinya ditutup. Untuk menonaktifkan tanpa menutup aplikasi: **Settings → Developer**, lalu matikan atau hapus `figma-bridge`.

**Memperbarui setelah `git pull`**

1. Tutup Claude Desktop sepenuhnya, lalu buka lagi (supaya server baru dipakai).
2. Di Figma, tutup jendela Claude Bridge lalu jalankan lagi dari Plugins → Development. Tidak perlu impor ulang, kecuali `plugin/manifest.json` berubah.

## Pemecahan masalah

| Gejala | Penyebab dan solusi |
|---|---|
| `claude : The term 'claude' is not recognized` | Claude Code belum terpasang. Pasang dengan `npm install -g @anthropic-ai/claude-code`, atau pakai Claude Desktop. |
| `figma-bridge` berstatus **Failed** / "Connection closed" | Klik **View logs**. Pastikan path di konfigurasi benar (pakai `/`), `npm install` sudah dijalankan, dan Node.js terpasang. Lalu restart Claude Desktop sepenuhnya. |
| Figma: `Manifest error: Invalid value for devAllowedDomains` | Figma menolak alamat IP. `devAllowedDomains` harus `["ws://localhost:3055"]` (sudah begitu di repo ini). |
| Claude menjawab "Figma plugin is not connected" | Jendela plugin belum dibuka atau tertutup. Buka lagi lewat Plugins → Development → Claude Bridge sampai titik hijau. Perbarui ke versi terbaru (ada dukungan relay untuk beberapa instance server). |
| Titik di jendela plugin tetap merah | Server belum jalan (cek `figma-bridge` di Settings → Developer), atau port berbeda. Samakan kolom **Port** di jendela plugin dengan `FIGMA_BRIDGE_PORT` (default 3055). |
| Port 3055 dipakai | Set `FIGMA_BRIDGE_PORT` di environment server, isi port yang sama di jendela plugin, dan ubah `devAllowedDomains` di `plugin/manifest.json` menjadi `ws://localhost:PORT`. |
| `Font "..." is not available` | Pakai `fontFamily: "Inter"` dengan `fontStyle` `Regular`/`Medium`/`Semi Bold`/`Bold`, atau font lain yang terpasang. |
| `Timed out after 30s` | Operasi besar bisa lama. Naikkan `FIGMA_BRIDGE_TIMEOUT_MS` (default 30000). |
| `Unsupported image format` | Fill gambar hanya menerima PNG, JPEG, GIF. Konversi WebP/SVG dulu. |

Catatan: Claude Desktop bisa menjalankan server ini lebih dari sekali (misalnya untuk chat dan sesi Code). Server sudah menangani ini: satu instance memegang koneksi ke plugin, instance lain meneruskan perintahnya lewat instance itu, dan mengambil alih bila yang pertama berhenti.

## Pengembangan dan tes

```bash
npm test                    # server MCP, relay antar instance, fill gambar
node test/plugin-mock.js    # logika plugin dengan Figma API tiruan
```

Semua tes memakai Figma tiruan, bukan Figma asli. Uji perubahan di file Figma kosong dulu.

Struktur:

```
server/index.js      server MCP + WebSocket bridge (+ relay antar instance, pemuat gambar)
plugin/manifest.json manifest plugin Figma
plugin/code.js       kode utama plugin (Figma Plugin API)
plugin/ui.html       jendela plugin (WebSocket, pengaturan, slot)
test/                tes otomatis
```

## Catatan keamanan

- Server hanya mendengarkan di `127.0.0.1` (tidak terbuka ke jaringan), tetapi program lain di komputermu yang tahu port-nya bisa terhubung. Pakai di komputer pribadi.
- Karena Claude dapat membaca file gambar dari `path` yang ia tentukan, jangan jalankan brief dari sumber yang tidak kamu percayai. Server hanya meneruskan file yang terbukti PNG/JPEG/GIF ke Figma, dan hanya sampai 12 MB.
- Plugin ini dibuat untuk pemakaian pribadi (mode development), bukan untuk dipublikasikan ke Figma Community.
