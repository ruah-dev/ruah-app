import express from "express";
import { createInvoice, listInvoices } from "./db.js";
import { invoiceCreated } from "./events.js";

const app = express();
app.use(express.json());

app.get("/invoices", async (_req, res) => {
  res.json(await listInvoices());
});

app.post("/invoices", async (req, res) => {
  const invoice = await createInvoice(req.body);
  await invoiceCreated(invoice);
  res.status(201).json(invoice);
});

app.listen(Number(process.env.PORT ?? 8080));
