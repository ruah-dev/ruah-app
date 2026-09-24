// Stand-in for the pg pool (the fixture has no node_modules).
const query = (sql: string): string[] => [sql];

export const listOrders = (): string[] => query("select * from orders limit 50");
