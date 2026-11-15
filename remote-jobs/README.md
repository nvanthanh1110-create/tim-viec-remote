# Việc Remote Cho Tôi

Trang tổng hợp việc remote: **SEO / Content**, **AI training**, **Dịch thuật (MTPE)**, **Trợ lý ảo / Marketing**.

- `fetch-jobs.mjs`: lấy tin từ Remotive, Remote OK, Jobicy, Himalayas, We Work Remotely, Working Nomads (API/RSS công khai), lọc theo từ khoá, ghi `jobs.json`.
- `index.html`: trang xem việc, lọc theo nhóm, khu vực và loại hợp đồng. Lưu việc và đánh dấu đã apply (lưu trên trình duyệt). Kèm danh bạ nền tảng nên đăng ký và mẹo tránh lừa đảo.
- `.github/workflows/remote-jobs.yml`: chạy 2 lần/ngày (06:17 và 18:17 giờ VN), đưa trang lên GitHub Pages.

## Bật lần đầu
1. Merge nhánh này vào nhánh mặc định của repo (lịch tự chạy chỉ hoạt động trên nhánh mặc định).
2. Vào **Settings → Pages → Build and deployment → Source** và chọn **GitHub Actions**.
3. Vào **Actions → Remote jobs feed → Run workflow** để chạy lần đầu. Link trang hiện trong kết quả của bước `deploy`.

## Thêm hoặc bớt từ khoá
Sửa `CATEGORIES` trong `fetch-jobs.mjs` (khớp trên tiêu đề và tag của tin).

## Chạy thử trên máy
```bash
node remote-jobs/fetch-jobs.mjs
cd remote-jobs && python3 -m http.server 8000
```
