// @ts-nocheck — fixture source (no node_modules); scanned, never compiled.
import express from "express";
import accounts from "./routes/accounts";
import transfers from "./routes/transfers";

const app = express();
app.use(express.json());
app.use(accounts);
app.use(transfers);
app.listen(3000);
