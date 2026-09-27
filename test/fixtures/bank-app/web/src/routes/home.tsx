// @ts-nocheck — fixture source (no node_modules); scanned, never compiled.
import { Link } from "react-router-dom";

export function BalanceCard({ balance }: { balance: number }) {
  return <section>Available: {balance}</section>;
}

export function QuickActions() {
  return <Link to="/transfer/new">Transfer</Link>;
}

export default function Home() {
  return (
    <main>
      <BalanceCard balance={0} />
      <QuickActions />
    </main>
  );
}
