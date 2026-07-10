import AdmZip from "adm-zip";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const mediaRoot = process.env.MEDIA_CACHE_DIR || path.resolve("data", "media-cache");
const maxAttachmentBytes = Number(process.env.MEDIA_MAX_ATTACHMENT_BYTES || 25 * 1024 * 1024);
const maxEntryBytes = Number(process.env.MEDIA_MAX_ENTRY_BYTES || 15 * 1024 * 1024);
const maxEntries = Number(process.env.MEDIA_MAX_ENTRIES || 30);
const previewDpi = Number(process.env.PDF_PREVIEW_DPI || 96);
const pdfTimeoutMs = Number(process.env.PDF_CONVERT_TIMEOUT_MS || 120_000);
const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const inFlight = new Map();

export const getProductMediaRoot = () => mediaRoot;

const run = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: process.platform === "win32",
      windowsHide: true
    });
    let errorOutput = "";
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error("Tạo ảnh xem trước PDF quá thời gian cho phép."));
    }, pdfTimeoutMs);

    child.stderr.on("data", (chunk) => {
      errorOutput += chunk.toString();
    });
    child.on("error", (error) => {
      finish(error);
    });
    child.on("close", (code) => {
      if (code === 0) finish();
      else finish(new Error(`Không thể tạo ảnh xem trước PDF (${code}): ${errorOutput.trim()}`));
    });
  });

const readManifest = async (directory) => {
  try {
    return JSON.parse(await fs.readFile(path.join(directory, "media.json"), "utf8"));
  } catch {
    return null;
  }
};

const publicUrl = (productId, cacheKey, relativePath) =>
  `/media/${productId}/${cacheKey}/${relativePath
    .split(path.sep)
    .map(encodeURIComponent)
    .join("/")}`;

async function buildProductMedia({ attachment, productId }) {
  if (!attachment.binarydata || attachment.binarydata.length > maxAttachmentBytes) {
    throw new Error("Attachment sản phẩm rỗng hoặc vượt quá dung lượng cho phép.");
  }

  const cacheKey = `${attachment.ad_attachment_id}-${new Date(attachment.updated).getTime()}`;
  const directory = path.join(mediaRoot, String(productId), cacheKey);
  const existing = await readManifest(directory);
  if (existing) return existing;

  await fs.rm(directory, { recursive: true, force: true });
  await fs.mkdir(directory, { recursive: true });

  const zip = new AdmZip(attachment.binarydata);
  const entries = zip.getEntries().filter((entry) => !entry.isDirectory);
  if (entries.length > maxEntries) {
    throw new Error("Attachment có quá nhiều file.");
  }

  const images = [];
  let imageNumber = 0;
  let pdfNumber = 0;

  for (const entry of entries) {
    const originalName = path.basename(entry.entryName);
    const extension = path.extname(originalName).toLowerCase();
    if (entry.header.size > maxEntryBytes) continue;
    const data = entry.getData();
    if (data.length > maxEntryBytes) continue;

    if (imageExtensions.has(extension)) {
      imageNumber += 1;
      const fileName = `image-${imageNumber}${extension}`;
      const relativePath = path.join("images", fileName);
      await fs.mkdir(path.join(directory, "images"), { recursive: true });
      await fs.writeFile(path.join(directory, relativePath), data);
      images.push({
        url: publicUrl(productId, cacheKey, relativePath),
        alt: `Hình ảnh sản phẩm: ${originalName}`
      });
      continue;
    }

    if (extension !== ".pdf") continue;

    pdfNumber += 1;
    const pdfDirectory = path.join(directory, "pdf", `document-${pdfNumber}`);
    const sourcePdf = path.join(pdfDirectory, "source.pdf");
    const outputPrefix = path.join(pdfDirectory, "page");
    await fs.mkdir(pdfDirectory, { recursive: true });
    await fs.writeFile(sourcePdf, data);

    try {
      const pdfToPpm =
        process.env.PDFTOPPM_PATH || (process.platform === "win32" ? "pdftoppm.cmd" : "pdftoppm");
      await run(pdfToPpm, [
        "-png",
        "-r",
        String(previewDpi),
        sourcePdf,
        outputPrefix
      ]);

      const pages = (await fs.readdir(pdfDirectory))
        .filter((file) => /^page-\d+\.png$/i.test(file))
        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));

      for (const page of pages) {
        const relativePath = path.join("pdf", `document-${pdfNumber}`, page);
        images.push({
          url: publicUrl(productId, cacheKey, relativePath),
          alt: `Trang tài liệu ${images.length + 1}: ${originalName}`
        });
      }
    } catch (error) {
      console.error(`Không thể tạo preview PDF cho sản phẩm ${productId}:`, error.message);
    }
  }

  const manifest = { images };
  await fs.writeFile(path.join(directory, "media.json"), JSON.stringify(manifest), "utf8");
  return manifest;
}

export async function ensureProductMedia({ pool, schema, productId }) {
  if (!productId) return { images: [] };

  const key = String(productId);
  if (inFlight.has(key)) return inFlight.get(key);

  const operation = (async () => {
    const result = await pool.query(
      `
        select ad_attachment_id, binarydata, updated
          from ${schema}.ad_attachment
         where ad_table_id = 1000218
           and record_id = $1
           and isactive = 'Y'
         order by updated desc
         limit 1
      `,
      [productId]
    );

    if (result.rowCount === 0) return { images: [] };
    return buildProductMedia({ attachment: result.rows[0], productId });
  })();

  inFlight.set(key, operation);
  try {
    return await operation;
  } finally {
    inFlight.delete(key);
  }
}
