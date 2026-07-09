import pg from "pg";

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

const fallbackImages = [
  "/public/images/product.jpg",
  "/public/images/product-detail-1.png",
  "/public/images/product-detail-3.png",
  "/public/images/product-detail-4.png"
];

export async function findIssuedLabelByHash(hash) {
  const client = await pool.connect();

  try {
    await client.query("begin");

    const result = await client.query(
      `
        select
          l.scm_label_id,
          l.documentno as serial_number,
          l.trackinghash,
          l.labelstatus,
          l.issuedate,
          l.scancount,
          l.productfeature,
          l.projectarea,
          l.deliverydate,
          l.tccompletiondate,
          l.activationdate,
          l.warrantymonths,
          l.warrantyenddate,
          b.circulationlicenseno,
          b.circulationlicensedate,
          b.coreference,
          b.cqreference,
          p.name as product_name,
          p.productfeature as demo_product_feature
        from ${schema}.scm_label l
        left join ${schema}.scm_labelbatch b on b.scm_labelbatch_id = l.scm_labelbatch_id
        left join ${schema}.scm_demoproduct p on p.scm_demoproduct_id = l.scm_demoproduct_id
        where lower(l.trackinghash) = $1
          and l.isactive = 'Y'
          and l.labelstatus = 'ISSUED'
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

    const feature = row.productfeature || row.demo_product_feature || "";
    const warrantyMonths = row.warrantymonths ? `${Number(row.warrantymonths)} tháng` : "";

    return {
      issuedDate: formatDate(row.issuedate),
      serialNumber: row.serial_number || "",
      certificateNumber: row.circulationlicenseno || "",
      organizationName: "Công ty Cổ phần SAIGONCOMM",
      scanCount: Number(scan.rows[0]?.scancount || row.scancount || 0),
      productName: row.product_name || "Thông tin sản phẩm",
      productFeature: feature,
      projectArea: row.projectarea || "",
      deliveryDate: formatDate(row.deliverydate),
      tcCompletionDate: formatDate(row.tccompletiondate),
      activationDate: formatDate(row.activationdate),
      warrantyMonths,
      warrantyEndDate: formatDate(row.warrantyenddate),
      circulationLicenseDate: formatDate(row.circulationlicensedate),
      coReference: row.coreference || "",
      cqReference: row.cqreference || "",
      certificateImage: "/public/images/certificate.jpg",
      productImages: fallbackImages,
      descriptionTitle: row.product_name || "Thông tin sản phẩm",
      description:
        "Thông tin bên dưới được phát hành từ hệ thống quản lý tem lưu hành của Saigoncomm.",
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
