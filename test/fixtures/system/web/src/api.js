const base = import.meta.env.INVOICES_URL ?? "http://invoices-api:8080";

export async function listInvoices() {
  const res = await fetch(`${base}/invoices`);
  return res.json();
}
