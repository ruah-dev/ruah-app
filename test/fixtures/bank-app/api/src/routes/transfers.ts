// @ts-nocheck — fixture source (no node_modules); scanned, never compiled.
import { Router } from "express";
import { pool } from "../db";

const router = Router();

router.post("/transfers", async (req, res) => {
  const { rows } = await pool.query("insert into transfers (to_account, amount) values ($1, $2) returning id", [req.body.to, req.body.amount]);
  res.status(201).json({ id: rows[0].id });
});

export default router;
