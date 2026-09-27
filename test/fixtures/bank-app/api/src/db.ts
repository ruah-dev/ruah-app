// @ts-nocheck — fixture source (no node_modules); scanned, never compiled.
import pg from "pg";

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
