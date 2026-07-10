import AdmZip from "adm-zip";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const productTableId = 1000218;
const maxAttachmentBytes = Number(process.env.MEDIA_MAX_ATTACHMENT_BYTES || 25 * 1024 * 1024);
const maxEntryBytes = Number(process.env.MEDIA_MAX_ENTRY_BYTES || 15 * 1024 * 1024);
const maxEntries = Number(process.env.MEDIA_MAX_ENTRIES || 30);
const previewDpi = Number(process.env.PDF_PREVIEW_DPI || 96);
const pdfTimeoutMs = Number(process.env.PDF_CONVERT_TIMEOUT_MS || 120_000);
const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const mimeByExtension = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp"
};
let workerRunning = false;

const run = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let errorOutput = "";
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error("Tạo ảnh xem trước PDF quá thời gian cho phép."));
    }, pdfTimeoutMs);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      error ? reject(error) : resolve();
    };

    child.stderr.on("data", (chunk) => {
      errorOutput += chunk.toString();
    });
    child.on("error", finish);
    child.on("close", (code) => {
      finish(code === 0 ? null : new Error(`Không thể tạo ảnh xem trước PDF: ${errorOutput.trim()}`));
    });
  });

const sourceChecksum = (binarydata) => createHash("sha256").update(binarydata).digest("hex");
const extensionOf = (name) => path.extname(name || "").toLowerCase();
const isZip = (binarydata) => binarydata.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
const isPdf = (binarydata) => binarydata.subarray(0, 5).equals(Buffer.from("%PDF-"));

const assertSize = (binarydata, message) => {
  if (!binarydata?.length || binarydata.length > maxEntryBytes) throw new Error(message);
};

async function renderPdf(binarydata, originalName, pageStart) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scm-media-"));
  try {
    const sourcePdf = path.join(directory, "source.pdf");
    const outputPrefix = path.join(directory, "page");
    await fs.writeFile(sourcePdf, binarydata);
    await run(process.env.PDFTOPPM_PATH || "pdftoppm", ["-png", "-r", String(previewDpi), sourcePdf, outputPrefix]);
    const pages = (await fs.readdir(directory))
      .filter((file) => /^page-\d+\.png$/i.test(file))
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
    if (!pages.length) throw new Error("PDF không có trang ảnh hợp lệ.");
    return Promise.all(
      pages.map(async (page, index) => ({
        mediaType: "PDF_PAGE",
        pageNo: pageStart + index,
        fileName: `${path.basename(originalName, extensionOf(originalName)) || "tai-lieu"}-trang-${index + 1}.png`,
        mimeType: "image/png",
        binaryData: await fs.readFile(path.join(directory, page))
      }))
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function renderFile(binarydata, originalName, imagePageNo, pdfPageNo) {
  assertSize(binarydata, "Tệp trong attachment rỗng hoặc vượt dung lượng cho phép.");
  const extension = extensionOf(originalName);
  if (isPdf(binarydata) || extension === ".pdf") {
    return renderPdf(binarydata, originalName, pdfPageNo);
  }
  if (imageExtensions.has(extension)) {
    return [{
      mediaType: "IMAGE",
      pageNo: imagePageNo,
      fileName: path.basename(originalName) || `anh-${imagePageNo}${extension}`,
      mimeType: mimeByExtension[extension],
      binaryData: binarydata
    }];
  }
  return [];
}

async function renderAttachment(attachment) {
  const source = attachment.binarydata;
  if (!source?.length || source.length > maxAttachmentBytes) {
    throw new Error("Attachment sản phẩm rỗng hoặc vượt dung lượng cho phép.");
  }

  const files = [];
  if (isZip(source)) {
    const entries = new AdmZip(source).getEntries().filter((entry) => !entry.isDirectory);
    if (entries.length > maxEntries) throw new Error("ZIP có quá nhiều tệp.");
    for (const entry of entries) {
      const binarydata = entry.getData();
      if (binarydata.length > maxEntryBytes) continue;
      files.push({ binarydata, name: path.basename(entry.entryName) });
    }
  } else {
    files.push({ binarydata: source, name: attachment.title || "tep-dinh-kem" });
  }

  const media = [];
  let imagePageNo = 1;
  let pdfPageNo = 1;
  for (const file of files) {
    const output = await renderFile(file.binarydata, file.name, imagePageNo, pdfPageNo);
    for (const item of output) {
      media.push(item);
      if (item.mediaType === "IMAGE") imagePageNo += 1;
      else pdfPageNo += 1;
    }
  }
  if (!media.length) throw new Error("Attachment không chứa ảnh hoặc PDF được hỗ trợ.");
  return media;
}

async function storeMedia(pool, schema, attachment, media, errorMessage = null) {
  const client = await pool.connect();
  const checksum = sourceChecksum(attachment.binarydata);
  try {
    await client.query("begin");
    await client.query(
      `update ${schema}.scm_productmedia
          set isactive = 'N', updated = now(), updatedby = 100
        where sourceattachment_id = $1 and isactive = 'Y' and sourcechecksum <> $2`,
      [attachment.ad_attachment_id, checksum]
    );

    const rows = media.length
      ? media
      : [{ mediaType: "IMAGE", pageNo: 0, fileName: "loi-xu-ly.txt", mimeType: "text/plain", binaryData: Buffer.alloc(0) }];
    for (const item of rows) {
      await client.query(
        `insert into ${schema}.scm_productmedia (
          scm_productmedia_id, ad_client_id, ad_org_id, isactive, created, createdby, updated, updatedby,
          scm_demoproduct_id, sourceattachment_id, sourceupdated, sourcechecksum,
          mediatype, pageno, filename, mimetype, binarydata, processstatus, errormessage
        ) values (
          nextval('${schema}.scm_productmedia_sq'), 11, 0, 'Y', now(), 100, now(), 100,
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
        ) on conflict (sourceattachment_id, sourcechecksum, mediatype, pageno, filename)
          where isactive = 'Y' do nothing`,
        [
          attachment.record_id,
          attachment.ad_attachment_id,
          attachment.updated,
          checksum,
          item.mediaType,
          item.pageNo,
          item.fileName,
          item.mimeType,
          item.binaryData,
          errorMessage ? "ERROR" : "READY",
          errorMessage
        ]
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function processPendingProductMedia({ pool, schema, limit = 5 }) {
  if (workerRunning) return { processed: 0, skipped: true };
  workerRunning = true;
  try {
    const candidates = await pool.query(
      `select a.ad_attachment_id, a.record_id, a.title, a.binarydata, a.updated
         from ${schema}.ad_attachment a
        where a.ad_table_id = $1
          and a.isactive = 'Y'
          and not exists (
            select 1 from ${schema}.scm_productmedia m
             where m.sourceattachment_id = a.ad_attachment_id
               and m.sourceupdated = a.updated
               and m.isactive = 'Y'
               and m.processstatus in ('READY', 'ERROR')
          )
        order by a.updated
        limit $2`,
      [productTableId, limit]
    );
    for (const attachment of candidates.rows) {
      try {
        await storeMedia(pool, schema, attachment, await renderAttachment(attachment));
      } catch (error) {
        await storeMedia(pool, schema, attachment, [], error.message);
        console.error(`Không thể xử lý attachment ${attachment.ad_attachment_id}:`, error.message);
      }
    }
    return { processed: candidates.rowCount, skipped: false };
  } finally {
    workerRunning = false;
  }
}

export async function listProductMedia({ pool, schema, productId }) {
  if (!productId) return [];
  const result = await pool.query(
    `select scm_productmedia_id, filename
       from ${schema}.scm_productmedia
      where scm_demoproduct_id = $1
        and isactive = 'Y'
        and processstatus = 'READY'
      order by case mediatype when 'IMAGE' then 0 else 1 end, pageno, scm_productmedia_id`,
    [productId]
  );
  return result.rows.map((row) => ({
    url: `/media/${row.scm_productmedia_id}`,
    alt: `Hình ảnh hoặc tài liệu sản phẩm: ${row.filename}`
  }));
}

export async function readProductMedia({ pool, schema, mediaId }) {
  const result = await pool.query(
    `select filename, mimetype, binarydata
       from ${schema}.scm_productmedia
      where scm_productmedia_id = $1
        and isactive = 'Y'
        and processstatus = 'READY'`,
    [mediaId]
  );
  return result.rows[0] ?? null;
}
