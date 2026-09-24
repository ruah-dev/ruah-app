import { listOrders } from "./routes/orders.js";

export const routes: Record<string, () => string[]> = { "/orders": listOrders };
