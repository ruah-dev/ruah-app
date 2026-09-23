import { listUsers } from "./routes/users.js";

export const main = (): number => listUsers().length;
