import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findIssuedLabelByHash } from "./data/labels.js";
import { getProductMediaRoot } from "./product-media.js";

const app = express();
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(currentDir, "..");

app.disable("x-powered-by");
app.set("view engine", "ejs");
app.set("views", path.join(projectDir, "views"));
app.use("/public", express.static(path.join(projectDir, "public"), { maxAge: 0 }));
app.use("/media", express.static(getProductMediaRoot(), { maxAge: "1h", index: false }));

app.get("/", async (req, res, next) => {
  const id = String(req.query.id ?? "").trim().toLowerCase();

  if (!/^[a-f0-9]{32,64}$/.test(id)) {
    return res.status(404).render("not-found", {
      message: "Không tìm thấy thông tin tem."
    });
  }

  try {
    const label = await findIssuedLabelByHash(id);
    if (!label) {
      return res.status(404).render("not-found", {
        message: "Tem chưa được gán vào sản phẩm hoặc không tồn tại."
      });
    }

    return res.render("product", { label });
  } catch (error) {
    return next(error);
  }
});

app.use((req, res) => {
  res.status(404).render("not-found", {
    message: "Không tìm thấy trang yêu cầu."
  });
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).render("not-found", {
    message: "Hệ thống đang bận, vui lòng thử lại sau."
  });
});

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";

app.listen(port, host, () => {
  console.log(`SCM đang chạy tại http://127.0.0.1:${port}`);
});
