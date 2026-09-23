import { query } from "../db/client.js";

export const listUsers = (): string[] => query("select * from users");
