import pg from "pg";
import { ensureProductMedia } from "../product-media.js";

const { Pool } = pg;
const schema = process.env.DB_SCHEMA || "adempiere";

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 5,
  idleTimeoutMillis: 30_000
});

const formatDate = (value) => {
  if (!value) return "";
  return new Intl.DateTimeFormat("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Asia/Ho_Chi_Minh"
  }).format(new Date(value));
};

export async function findIssuedLabelByHash(hash) {
  const client = await pool.connect();

  try {
    await client.query("begin");

    const result = await client.query(
      `
        select
          l.scm_label_id,
          l.documentno as serial_number,
          l.issuedate,
          l.scancount,
          l.productfeature,
          l.projectarea,
          l.deliverydate,
          l.tccompletiondate,
          l.activationdate,
          l.warrantymonths,
          l.warrantyenddate,
          p.name as product_name,
          p.productfeature as product_default_feature,
          p.circulationlicenseno as circulation_license_no,
          p.circulationlicensedate as circulation_license_date,
          p.coreference as co_reference,
          p.cqreference as cq_reference
        from ${schema}.scm_label l
        left join ${schema}.scm_demoproduct p
          on p.scm_demoproduct_id = l.scm_demoproduct_id
        where lower(l.trackinghash) = $1
          and l.isactive = 'Y'
          and l.isassigned = 'Y'
          and l.scm_demoproduct_id is not null
        limit 1
        for update of l
      `,
      [hash]
    );

    if (result.rowCount === 0) {
      await client.query("rollback");
      return null;
    }

    const row = result.rows[0];
    const scan = await client.query(
      `
        update ${schema}.scm_label
           set scancount = coalesce(scancount, 0) + 1,
               updated = now(),
               updatedby = 100
         where scm_label_id = $1
         returning scancount
      `,
      [row.scm_label_id]
    );

    await client.query("commit");

    const warrantyMonths = row.warrantymonths
      ? `${Number(row.warrantymonths)} tháng`
      : "";

    return {
      issuedDate: formatDate(row.issuedate),
      serialNumber: row.serial_number || "",
      organizationName: "Công ty Cổ phần SAIGONCOMM",
      scanCount: Number(scan.rows[0]?.scancount || row.scancount || 0),
      productName: row.product_name || "",
      productFeature: row.productfeature || row.product_default_feature || "",
      projectArea: row.projectarea || "",
      deliveryDate: formatDate(row.deliverydate),
      tcCompletionDate: formatDate(row.tccompletiondate),
      activationDate: formatDate(row.activationdate),
      warrantyMonths,
      warrantyEndDate: formatDate(row.warrantyenddate),
      circulationLicenseNo: row.circulation_license_no || "",
      circulationLicenseDate: formatDate(row.circulation_license_date),
      coReference: row.co_reference || "",
      cqReference: row.cq_reference || "",
      productImages: (
        await ensureProductMedia({
          pool,
          schema,
          productId: row.scm_demoproduct_id
        }).catch((error) => {
          console.error(`Không thể đọc attachment sản phẩm ${row.scm_demoproduct_id}:`, error.message);
          return { images: [] };
        })
      ).images,
      issuer: {
        name: "CÔNG TY CỔ PHẦN SAIGONCOMM",
        address:
          "32 đường 27, Khu đô thị Vạn Phúc, Khu phố 5, Phường Hiệp Bình Phước, Thành phố Thủ Đức, TP. Hồ Chí Minh",
        phone: "",
        email: "",
        website: "https://saigoncomm.vn"
      }
    };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function closeLabelPool() {
  await pool.end();
}
