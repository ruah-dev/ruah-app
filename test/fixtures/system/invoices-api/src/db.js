import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export async function listInvoices() {
  const { rows } = await pool.query("select * from invoices order by created_at desc");
  return rows;
}

export async function createInvoice(input) {
  const { rows } = await pool.query("insert into invoices (customer, total) values ($1, $2) returning *", [
    input.customer,
    input.total,
  ]);
  return rows[0];
}
