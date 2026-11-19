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

> **English summary:** a Figma plugin plus a local MCP server that lets Claude (Claude Desktop or Claude Code) design directly in Figma: create and edit frames, text, auto layout, gradients, images, vectors, variables and components, import an HTML page as auto-layout frames, and export nodes as SVG/PNG. It talks to the plugin over a WebSocket on `127.0.0.1` only and needs no API key. Quick start: `npm install`, import `plugin/manifest.json` in Figma (Plugins → Development → Import plugin from manifest), add the server (`node server/index.js`) to your MCP client config, then open the plugin in Figma. The detailed guide below is in Indonesian. Requires Node.js 18+ and the Figma desktop app. Run `npm test` for the test suite.
>
> **Unofficial project:** not affiliated with or endorsed by Figma or Anthropic. Claude can modify your Figma file, so try it on a copy first. Licensed under MIT, see [LICENSE](LICENSE).


## Fitur

- **Buat dan ubah desain**: frame, teks, shape, auto layout, gradient, shadow, sudut bulat, struktur bertingkat dalam satu perintah.
- **Fill gambar**: dari file di komputer, URL, base64, atau salin dari node lain.
- **Impor dari HTML**: ubah halaman web (HTML + CSS) jadi frame auto layout di Figma.
- **Vector dan boolean**: gambar path sendiri, gabungkan bentuk (union, subtract, intersect, exclude).
- **Teks dengan gaya campuran**: satu teks berisi bagian tebal, berwarna, atau bergaris bawah.
- **Variable (token)**: buat collection, mode, dan variable dari daftar token.
- **Ekspor SVG**: ambil logo atau ikon sebagai SVG, bisa langsung disimpan ke file.
- **Animasi build**: desain muncul bertahap seperti digambar langsung.
- **Dua slot (Sumber → Target)**: pilih desain berisi informasi dan desain yang mau diubah, lalu beri brief lewat Claude.
- **Claude bisa melihat hasilnya**: ekspor node jadi gambar, lalu memperbaiki sendiri.

## Isi

- [Prasyarat](#prasyarat)
- [Tutorial pemasangan](#tutorial-pemasangan)
- [Cara pakai](#cara-pakai)
- [Fitur lanjutan](#fitur-lanjutan)
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

1. Buka **Settings → Desktop app**, scroll ke bawah ke baris **Extensions**, klik **Manage**. Di halaman itu, bagian **Local MCP servers**, klik **Edit config** (di versi lama menunya bernama **Developer**). Folder yang berisi `claude_desktop_config.json` akan terbuka; buka file itu dengan editor teks (Notepad/VS Code).
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
4. Cek di **Settings → Desktop app → Extensions → Manage → Local MCP servers**: `figma-bridge` harus berstatus *Running*.

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

## Fitur lanjutan

Bagian ini berasal dari daftar perbaikan setelah bridge dipakai memindahkan halaman web ke Figma.

### Impor dari HTML

`figma_import_html` membaca HTML + CSS dan membuat frame auto layout. Plugin merender halamannya di jendela tersembunyi (skrip di halaman tidak dijalankan), mengukur setiap kotak, lalu menerjemahkannya.

> Impor D:/proyek/index.html lebar 1440 ke halaman ini. Hanya section `#pricing`.

- Beri `htmlPath` (file di komputer) atau `html` (teks). Untuk `htmlPath`, stylesheet `<link>` dan gambar relatif dibaca dari folder yang sama. Untuk `html`, isi `baseDir` bila ada gambar relatif.
- Didukung: flexbox, grid, alur blok biasa, padding, gap, radius, warna, gradient, border, shadow, teks (font, berat, ukuran, tinggi baris, rata, huruf besar), gaya campuran di dalam satu teks (`<b>`, `<a>`, `<span>`), `<img>`, background image, `<svg>` inline, `position: absolute`, tombol, input.
- Tata letak diambil dari posisi hasil render: anak yang tersusun satu baris atau satu kolom jadi auto layout, grid jadi baris-baris, margin yang berbeda jadi frame `spacer` atau `margin`. Susunan lain diletakkan di koordinat absolut. `layout: "absolute"` memaksa semuanya absolut (persis seperti browser, tetapi tidak responsif).
- `dryRun: true` hanya menampilkan hasil konversi tanpa membuat apa-apa. `width` mengatur lebar halaman (390 untuk tampilan mobile), `selector` memilih satu bagian.
- Font dari CSS dipakai apa adanya. Font yang tidak ada di Figma diganti `fallbackFont` (default Inter) dan dilaporkan di `fontSubstitutions`. Ukur ulang teks bisa sedikit berbeda bila font itu tidak terpasang di komputermu.
- Ini perkiraan, bukan salinan piksel demi piksel. Yang tidak diimpor dilaporkan di `warnings`: `::before`/`::after`, transform, border yang berbeda per sisi, penanda daftar (bullet), dan `backdrop-filter`.

### Vector dan boolean

```
{ "type": "VECTOR", "path": "M 0 0 L 40 0 L 20 30 Z", "fills": "#2563EB", "width": 80, "height": 60 }
```

Sintaks path SVG: `M L H V C S Q T Z`, absolut atau relatif. Busur (`A`) belum didukung; untuk bentuk dengan busur pakai node `SVG`. `figma_boolean` menggabungkan bentuk: `UNION`, `SUBTRACT` (bentuk di depan memotong bentuk di belakang), `INTERSECT`, `EXCLUDE`. `flatten: true` menjadikannya satu vector biasa.

### Teks dengan gaya campuran

```
{ "type": "TEXT", "fontSize": 20, "runs": [
  { "text": "Hemat " },
  { "text": "30%", "fontStyle": "Bold", "color": "#E11D48", "fontSize": 28 }
] }
```

Tiap `run` boleh memuat `fontSize`, `fontFamily`, `fontStyle`, `color`, `textDecoration`, `letterSpacing`, `lineHeight`. Alternatifnya `ranges: [{ "start": 0, "end": 5, ... }]` untuk menata sebagian dari `characters`. `figma_get_node` mengembalikan `runs` bila gayanya berbeda-beda.

### Variable (token)

`figma_create_variables` membuat atau memperbarui collection, mode, dan variable dari satu daftar. Aman dijalankan ulang (dicocokkan lewat nama). Nilai per mode, dan alias ke variable lain ditulis `{ "alias": "core/blue/500" }`.

> Buat collection `core` (blue/500 = #3B82F6, radius/md = 12) dan collection `theme` dengan mode Light dan Dark: `primary` Light mengacu ke core/blue/500, Dark = #60A5FA.

### Arah gradient

Pilih salah satu: `direction` (seperti CSS: `"to bottom"`, `"to bottom right"`), `cssAngle` (konvensi CSS: 0 = ke atas, 90 = ke kanan, 180 = ke bawah), atau `angle` (0 = kiri ke kanan, 90 = atas ke bawah, searah jarum jam).

```
{ "type": "GRADIENT_LINEAR", "direction": "to bottom", "stops": [
  { "position": 0, "color": "#000000CC" }, { "position": 1, "color": "#00000000" } ] }
```

`figma_get_node` mengembalikan gradient dengan konvensi `angle` yang sama.

### Perilaku yang perlu diketahui

- Frame baru dengan auto layout otomatis **HUG** pada sumbu yang tidak kamu beri ukuran (bukan lagi 100×100).
- Teks diukur ulang otomatis setelah lebar, ukuran font, atau isi berubah, jadi tingginya langsung menyesuaikan.
- `index` pada `figma_create`, `figma_clone`, dan `figma_update` menentukan urutan (0 = anak pertama), tanpa perlu `figma_update` sesudahnya.
- `layoutPositioning: "ABSOLUTE"` mengeluarkan anak dari alur auto layout sehingga `x`/`y` berlaku (badge, gambar yang menimpa kartu). `constraints` boleh ditambahkan.
- `figma_get_node` juga mengembalikan `effects` (shadow dan blur) dengan format yang sama seperti `figma_create`. Id halaman atau id yang tidak dikenal memberi pesan yang jelas; `figma_list_children` mendaftar isi sebuah halaman atau node (dengan `pageName` untuk halaman lain).
- Gaya font dicocokkan lintas penulisan: `Semi Bold` (Inter) dan `SemiBold` (Poppins) sama-sama diterima.
- `figma_export` dengan `format: "SVG"` mengembalikan markup SVG (teks diubah jadi outline). `savePath: "D:/proyek/img/logo.svg"` menyimpannya ke file.

### Batasan

- **Responsif**: Figma tidak punya breakpoint, jadi satu impor menghasilkan satu lebar. Untuk versi lain, impor lagi dengan `width: 768` atau `390` ke frame terpisah.
- Konverter HTML diuji di Chromium, dan plugin diuji dengan Figma tiruan. Arah gradient dan pengukuran ulang teks belum diuji di Figma asli, jadi coba dulu di file percobaan.

## Referensi tool

| Tool | Fungsi |
|---|---|
| `figma_status` | Cek koneksi, nama file, halaman, jumlah seleksi |
| `figma_get_selection` | Baca node yang sedang dipilih |
| `figma_list_variables` | Daftar collection dan variable lokal di file (hanya baca) |
| `figma_get_node` | Baca node (atau halaman) berdasarkan id |
| `figma_get_slots` | Baca slot Sumber dan Target (teks berurutan, gambar, struktur) |
| `figma_set_slot` | Isi atau kosongkan slot (dari id atau seleksi saat ini) |
| `figma_list_children` | Daftar anak sebuah halaman atau node (id, nama, tipe, posisi, ukuran) |
| `figma_create` | Buat node, boleh bertingkat (auto layout, teks, gradient, shadow, gambar, vector, SVG) |
| `figma_import_html` | Ubah HTML + CSS jadi frame auto layout |
| `figma_boolean` | Union, subtract, intersect, exclude, dan flatten bentuk |
| `figma_create_variables` | Buat atau perbarui collection, mode, dan variable dari daftar token |
| `figma_update` | Ubah properti node, atau pindahkan ke parent lain |
| `figma_delete` | Hapus node (bisa di-undo di Figma) |
| `figma_clone` | Duplikat node |
| `figma_combine_variants` | Gabungkan node COMPONENT jadi satu component set (variant). Nama komponen harus `property=value, property=value` |
| `figma_arrange_variants` | Susun variant dalam component set menjadi grid rapi (`rows` dan `columns` berupa nama property variant) |
| `figma_rebind_variables` | Di satu node dan anak-anaknya, pindahkan variable dari satu collection ke variable bernama sama di collection lain (mis. `light` → `dark`) |
| `figma_create_variable` | Buat atau perbarui satu variable di collection yang sudah ada (warna hex, alias, atau composed color: warna + opacity) |
| `figma_create_instance` | Buat instance dari COMPONENT, atau dari variant tertentu di COMPONENT_SET (`variant:{size:"md"}`) |
| `figma_create_effect_style` | Buat atau perbarui effect style (mis. `elevation/2`); pasang ke node dengan `effectStyle` |
| `figma_create_text_style` | Buat atau perbarui text style (mis. `text/sm`), field-nya bisa diikat ke variable; pasang dengan prop `textStyle` |
| `figma_list_styles` | Daftar effect, text dan paint style lokal (hanya baca) |
| `figma_apply_text_styles` | Pasang text style lokal ke semua teks di bawah satu node (cocok lewat family, style dan ukuran font; isi instance dilewati; `dryRun` hanya melapor) |
| `figma_select` | Pilih node dan zoom ke sana |
| `figma_export` | Ekspor node jadi gambar (PNG/JPG) supaya Claude bisa melihat hasilnya, atau SVG (bisa disimpan ke file) |

Properti node yang didukung (ringkas): `type` (FRAME, COMPONENT, RECTANGLE, ELLIPSE, TEXT, LINE, POLYGON, STAR, VECTOR, SVG), `name`, `x`, `y`, `width`, `height`, `rotation`, `opacity`, `fills`, `strokes`, `cornerRadius`, `effects`, auto layout (`layoutMode`, `itemSpacing`, `padding`, `primaryAxisAlignItems`, `layoutSizingHorizontal` dst.), teks (`characters`, `fontSize`, `fontFamily`, `fontStyle`, `lineHeight`, `letterSpacing`, `textAlignHorizontal`), dan `children`. Daftar lengkap ada di deskripsi tool `figma_create`.

## Mematikan dan memperbarui

**Mematikan**

1. Tutup jendela **Claude Bridge** di Figma (tombol X). Claude tidak bisa lagi mengubah file Figma-mu.
2. Server MCP berjalan bersama Claude Desktop dan berhenti saat aplikasinya ditutup. Untuk menonaktifkan tanpa menutup aplikasi: **Settings → Desktop app → Extensions → Manage → Local MCP servers**, lalu matikan atau hapus `figma-bridge`.

**Memperbarui setelah `git pull`**

0. Kalau folder lokalmu punya perubahan sendiri yang tidak dipakai lagi (misalnya node `SVG` buatan sendiri, sekarang sudah ada di repo), simpan dulu dengan `git stash` atau buang dengan `git checkout -- .` sebelum menarik.
1. Tutup Claude Desktop sepenuhnya, lalu buka lagi (supaya server baru dipakai).
2. Di Figma, tutup jendela Claude Bridge lalu jalankan lagi dari Plugins → Development. Tidak perlu impor ulang, kecuali `plugin/manifest.json` berubah. Jendela itu wajib dibuka ulang setelah pembaruan yang mengubah `plugin/ui.html` (misalnya impor HTML).

## Pemecahan masalah

| Gejala | Penyebab dan solusi |
|---|---|
| `claude : The term 'claude' is not recognized` | Claude Code belum terpasang. Pasang dengan `npm install -g @anthropic-ai/claude-code`, atau pakai Claude Desktop. |
| `figma-bridge` berstatus **Failed** / "Connection closed" | Klik **View logs**. Pastikan path di konfigurasi benar (pakai `/`), `npm install` sudah dijalankan, dan Node.js terpasang. Lalu restart Claude Desktop sepenuhnya. |
| Figma: `Manifest error: Invalid value for devAllowedDomains` | Figma menolak alamat IP. `devAllowedDomains` harus `["ws://localhost:3055"]` (sudah begitu di repo ini). |
| Claude menjawab "Figma plugin is not connected" | Jendela plugin belum dibuka atau tertutup. Buka lagi lewat Plugins → Development → Claude Bridge sampai titik hijau. Perbarui ke versi terbaru (ada dukungan relay untuk beberapa instance server). |
| Titik di jendela plugin tetap merah | Server belum jalan (cek `figma-bridge` di Settings → Desktop app → Extensions → Manage → Local MCP servers), atau port berbeda. Samakan kolom **Port** di jendela plugin dengan `FIGMA_BRIDGE_PORT` (default 3055). |
| Port 3055 dipakai | Set `FIGMA_BRIDGE_PORT` di environment server, isi port yang sama di jendela plugin, dan ubah `devAllowedDomains` di `plugin/manifest.json` menjadi `ws://localhost:PORT`. |
| `Font "..." is not available` | Font itu tidak ada di Figma. Pakai font yang terpasang (mis. `Inter` dengan `Regular`/`Medium`/`Semi Bold`/`Bold`). `Semi Bold` dan `SemiBold` sudah dicocokkan otomatis. Untuk impor HTML font cadangan dipakai otomatis. |
| `Unknown command: html_to_spec` | Jendela plugin masih versi lama. Tutup dan buka lagi dari Plugins → Development. |
| `Timed out after 30s` | Operasi besar bisa lama. Naikkan `FIGMA_BRIDGE_TIMEOUT_MS` (default 30000). |
| `Unsupported image format` | Fill gambar hanya menerima PNG, JPEG, GIF. Konversi WebP/SVG dulu. |

Catatan: Claude Desktop bisa menjalankan server ini lebih dari sekali (misalnya untuk chat dan sesi Code). Server sudah menangani ini: satu instance memegang koneksi ke plugin, instance lain meneruskan perintahnya lewat instance itu, dan mengambil alih bila yang pertama berhenti.

## Pengembangan dan tes

```bash
npm test    # server MCP, relay, gambar, impor HTML, logika plugin (Figma tiruan), konverter HTML
```

Tes konverter HTML berjalan di Chromium lewat Playwright dan dilewati otomatis bila Playwright tidak terpasang (`npm i -D playwright && npx playwright install chromium` untuk menjalankannya). Semua tes memakai Figma tiruan, bukan Figma asli. Uji perubahan di file Figma kosong dulu.

Struktur:

```
server/index.js      server MCP + WebSocket bridge (+ relay antar instance, pemuat gambar, impor HTML)
plugin/manifest.json manifest plugin Figma
plugin/code.js       kode utama plugin (Figma Plugin API)
plugin/ui.html       jendela plugin (WebSocket, pengaturan, slot, konverter HTML ke desain)
test/                tes otomatis (test/fixtures: halaman contoh dan hasil konversinya)
```

## Catatan keamanan

- Server hanya mendengarkan di `127.0.0.1` (tidak terbuka ke jaringan), tetapi program lain di komputermu yang tahu port-nya bisa terhubung. Pakai di komputer pribadi.
- Impor HTML merender halaman di jendela tersembunyi tanpa menjalankan skrip dan tanpa memuat sumber luar. Stylesheet dan gambar lokal hanya dibaca dari folder HTML (atau `baseDir`). Tetap jangan impor HTML dari sumber yang tidak kamu percayai.
- Karena Claude dapat membaca file gambar dari `path` yang ia tentukan, jangan jalankan brief dari sumber yang tidak kamu percayai. Server hanya meneruskan file yang terbukti PNG/JPEG/GIF ke Figma, dan hanya sampai 12 MB.
- Plugin ini dibuat untuk pemakaian pribadi (mode development), bukan untuk dipublikasikan ke Figma Community.
