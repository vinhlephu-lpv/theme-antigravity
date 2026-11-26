# Antigravity Custom Theme Mod

Trình tùy biến giao diện nền động, màn hình khởi động và hiệu ứng kính mờ cho **Antigravity** mà không can thiệp vào tệp cài đặt gốc (`app.asar`) của ứng dụng.

![Minh họa giao diện Antigravity Custom Theme](docs/demo.webp)

> Mã nguồn này được phát triển và mở rộng dựa trên dự án mã nguồn mở [antigravity-custom-theme-skill](https://github.com/giakiet22102006/antigravity-custom-theme-skill) (giấy phép MIT).

---

## Giới thiệu mã nguồn

Hệ thống vận hành theo mô hình hai lớp tách biệt nhằm giữ ổn định khi Antigravity cập nhật phiên bản mới:

1. **Daemon nền và Media Server nội bộ (`daemon/theme_daemon.js`):**
   - Chạy nền trên máy, tự động dò tệp `DevToolsActivePort` của Antigravity và kết nối qua Chrome DevTools Protocol (CDP).
   - Mở HTTP Server cục bộ trên `127.0.0.1` (cổng ngẫu nhiên) để phục vụ tài nguyên trong `themes/assets/` và `themes/user_media/` (hỗ trợ phát video theo dải byte `Range 206`, tải lên tệp mới kèm kiểm tra trùng lặp theo mã băm MD5 và xóa tệp trên ổ đĩa).
   - Theo dõi thay đổi ở `dist/theme_payload.js` để nạp lại giao diện tức thì và đồng bộ thiết lập của người dùng vào `theme_config.json`.

2. **Bộ máy giao diện runtime (`engine/core.js`):**
   - Sau khi được `scripts/build_payload.py` đóng gói cùng `themes/themes.json` thành `dist/theme_payload.js`, script được tiêm vào cửa sổ Antigravity để dựng lớp nền `<agy-live-bg>`, bảng điều khiển **Custom Theme Studio**, màn hình khởi động Starfield Boot HUD và hiệu ứng vẽ nét trước khi loang màu nền.
   - Sử dụng ảnh kính mờ dựng sẵn (`syncPrebakedGlass`) kết hợp giới hạn bộ nhớ đệm và giải phóng bộ giải mã video khi chuyển sang chế độ ảnh tĩnh để giảm tiêu thụ RAM.

---

## Tính năng chính

- **Chế độ nền Ảnh tĩnh và Video động tách biệt:** Quản lý riêng danh sách ảnh tĩnh và video đã tải lên; tự động lưu lịch sử mỗi khi chọn tệp mới, hỗ trợ xem trước và xóa trực tiếp từng mục khỏi ổ cứng.
- **Preset mặc định đi kèm:** Bao gồm `Gemini-chan Live` (`themes/assets/wallpapergeminichan.mp4`), `Furina Live` (`themes/assets/furina-bg.mp4`), `WLOP Cosmic` và `Midnight Obsidian`.
- **Hiệu ứng vẽ nét và loang màu (Sketch Reveal):** Trích xuất đường nét trực tiếp từ khung hình video hoặc ảnh nền hiện tại qua thuật toán biên cạnh đa kênh màu kết hợp làm mượt đường cong.
- **Màn hình khởi động (Boot HUD):** Giao diện khởi động kèm âm thanh điều hướng, có thể bật/tắt hoặc phát lại từ bảng cài đặt.
- **Câu chào tùy chỉnh (Custom Greeting):** Cho phép tự soạn danh sách câu chào ngẫu nhiên hiển thị trên màn hình hội thoại trống bằng bộ phông chữ viết tay đóng gói ngoại tuyến.
- **Âm thanh báo hoàn thành tác vụ (Task Voice):** Hỗ trợ nạp nhiều tệp âm thanh (`.mp3`, `.wav`, `.ogg`, `.m4a`, `.aac`, `.flac`), phát ngẫu nhiên khi tác vụ kết thúc và giải phóng đối tượng âm thanh ngay sau khi phát xong.
- **Tùy biến khung chat và ảnh đại diện:** Thay đổi khung nhập liệu, bong bóng tin nhắn, ảnh đại diện User/Agent (tự nén WebP), độ tối nền và độ mờ kính.

---

## Yêu cầu hệ thống

- **Antigravity** đang hoạt động với cổng gỡ lỗi CDP (`DevToolsActivePort`).
- **Node.js từ phiên bản 22 trở lên** (sử dụng `WebSocket` tích hợp sẵn, không cần chạy `npm install`).
- **Python từ phiên bản 3.9 trở lên** để biên dịch `dist/theme_payload.js` (khuyến nghị cài thêm thư viện `Pillow` nếu muốn tự động nén ảnh nền độ phân giải cao sang WebP).

---

## Hướng dẫn cài đặt và sử dụng

### Bước 1: Tải mã nguồn

```bash
git clone https://github.com/furinamikuvn/antigravity-custom-theme-mod.git
cd antigravity-custom-theme-mod
```

### Bước 2: Biên dịch gói giao diện (`dist/theme_payload.js`)

```bash
python scripts/build_payload.py
```

Kiểm tra nhanh cú pháp sau khi biên dịch:

```bash
node --check dist/theme_payload.js
```

### Bước 3: Cài đặt và khởi chạy daemon nền

**Trên Windows (PowerShell):**

```powershell
powershell -ExecutionPolicy Bypass -File ".\scripts\install-win.ps1"
```

Lệnh trên tạo tệp `silent-start.vbs` cùng lối tắt khởi động trong thư mục `Startup` của Windows (`AntigravityCustomTheme.lnk`) và chạy daemon ngầm không hiện cửa sổ dòng lệnh. Khi tắt hoặc mở lại Antigravity, giao diện sẽ tự động được nạp lại.

Nếu muốn chạy trực tiếp `.\scripts\install-win.ps1` ở các lần sau mà không cần thêm `-ExecutionPolicy Bypass`, có thể mở khóa chính sách script cho người dùng hiện tại một lần bằng lệnh:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

**Trên macOS / Linux (Bash):**

```bash
bash scripts/install-unix.sh
```

- Trên **macOS**: cài đặt LaunchAgent tại `~/Library/LaunchAgents/io.antigravity.custom-theme.plist`.
- Trên **Linux**: cài đặt dịch vụ `systemd --user` (hoặc chạy nền qua `nohup`).
- Có thể dùng cờ `--foreground` để chạy trực tiếp trên terminal khi kiểm thử, hoặc `stop` / `status` để dừng và xem trạng thái.

### Bước 4: Kiểm tra trạng thái nạp qua CDP

Khi cửa sổ Antigravity đang mở, chạy lệnh:

```bash
node scripts/verify_cdp.js
```

Kết quả đạt yêu cầu sẽ báo `PASS` kèm thông tin số trang đã được áp dụng giao diện. Để mở bảng tùy chỉnh giao diện trong Antigravity, bấm mục **Custom theme** ở thanh bên trái hoặc nút **Open Custom Theme Studio** trong phần cài đặt **Appearance**.

---

## Gỡ cài đặt

Để dừng daemon nền, xóa lối tắt tự khởi động và trả giao diện Antigravity về trạng thái mặc định:

```bash
node scripts/uninstall.js
```

---

## Cấu trúc thư mục

```text
.
├── daemon/
│   └── theme_daemon.js        # Daemon kết nối CDP, HTTP Media Server và lưu cấu hình
├── engine/
│   └── core.js                # Mã nguồn giao diện runtime, Boot HUD, Sketch Reveal, Modal
├── scripts/
│   ├── build_payload.py       # Trình đóng gói themes.json + core.js -> dist/theme_payload.js
│   ├── install-win.ps1        # Script cài đặt và chạy ngầm trên Windows
│   ├── install-unix.sh        # Script cài đặt trên macOS / Linux
│   ├── uninstall.js           # Gỡ dịch vụ nền và khôi phục giao diện gốc
│   └── verify_cdp.js          # Kiểm tra trạng thái tiêm giao diện qua CDP
├── themes/
│   ├── themes.json            # Khai báo các preset giao diện mặc định
│   ├── assets/                # Video, poster, phông chữ và âm thanh mặc định
│   └── user_media/            # Tệp người dùng tải lên (kèm sẵn 1 mẫu voice hoàn thành task)
├── docs/
│   └── demo.webp              # Ảnh động minh họa giao diện cho README
├── references/
│   └── theme-schema.md        # Tài liệu cấu trúc dữ liệu themes.json
├── SKILL.md                   # Đặc tả cấu trúc Skill
└── LICENSE                    # Giấy phép MIT
```

---

## Giấy phép

Phát hành theo giấy phép **MIT** — xem chi tiết trong tệp [LICENSE](LICENSE).
