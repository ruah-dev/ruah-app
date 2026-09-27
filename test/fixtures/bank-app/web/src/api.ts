// @ts-nocheck — fixture source (no node_modules); scanned, never compiled.
export async function getBalance(accountId: string): Promise<number> {
  const res = await fetch(`/api/accounts/${accountId}/balance`);
  return (await res.json()).balance;
}

export async function sendTransfer(to: string, amount: number): Promise<{ id: string }> {
  const res = await fetch("/api/transfers", { method: "POST", body: JSON.stringify({ to, amount }) });
  return res.json();
}
