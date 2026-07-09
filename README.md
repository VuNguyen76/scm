# SCM

Trang tra cứu thông tin tem bằng Node.js và EJS.

## Chạy dự án

```powershell
npm install
npm start
```

Mở URL mẫu:

```text
http://127.0.0.1:3001/?id=85b02f180d1e86d2570e3b9a29ef0360
```

ID mẫu được tạo bằng MD5 của chuỗi `123HOCMON`.

## Cấu trúc chính

- `src/server.js`: route nhận tham số `id`.
- `src/data/labels.js`: nguồn dữ liệu tạm thời, có thể thay bằng PostgreSQL.
- `views/product.ejs`: giao diện thông tin sản phẩm.
- `public/images`: ảnh sản phẩm và giấy chứng nhận.
