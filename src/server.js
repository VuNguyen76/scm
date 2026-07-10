import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findIssuedLabelByHash, pool, schema } from "./data/labels.js";
import { processPendingProductMedia, readProductMedia } from "./product-media.js";

const app = express();
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(currentDir, "..");

app.disable("x-powered-by");
app.set("view engine", "ejs");
app.set("views", path.join(projectDir, "views"));
app.use("/public", express.static(path.join(projectDir, "public"), { maxAge: 0 }));

app.get("/media/:mediaId", async (req, res, next) => {
  const mediaId = Number(req.params.mediaId);
  if (!Number.isSafeInteger(mediaId) || mediaId <= 0) return res.sendStatus(404);
  try {
    const media = await readProductMedia({ pool, schema, mediaId });
    if (!media) return res.sendStatus(404);
    res.set({
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Type": media.mimetype,
      "Content-Disposition": `inline; filename="${encodeURIComponent(media.filename)}"`,
      "X-Content-Type-Options": "nosniff"
    });
    return res.send(media.binarydata);
  } catch (error) {
    return next(error);
  }
});

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
const mediaIntervalMs = Number(process.env.MEDIA_PROCESS_INTERVAL_MS || 5_000);

const prepareMedia = () =>
  processPendingProductMedia({ pool, schema }).catch((error) => {
    console.error("Không thể chuẩn bị media sản phẩm:", error.message);
  });

prepareMedia();
setInterval(prepareMedia, mediaIntervalMs).unref();

app.listen(port, host, () => {
  console.log(`SCM đang chạy tại http://127.0.0.1:${port}`);
});
