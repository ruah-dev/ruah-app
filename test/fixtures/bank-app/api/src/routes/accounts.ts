// @ts-nocheck — fixture source (no node_modules); scanned, never compiled.
import { Router } from "express";
import { pool } from "../db";

const router = Router();

router.get("/accounts/:id/balance", async (req, res) => {
  const { rows } = await pool.query("select balance from accounts where id = $1", [req.params.id]);
  res.json({ balance: rows[0]?.balance ?? 0 });
});

export default router;
