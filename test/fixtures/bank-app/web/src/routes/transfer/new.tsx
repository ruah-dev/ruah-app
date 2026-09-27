// @ts-nocheck — fixture source (no node_modules); scanned, never compiled.
import { sendTransfer } from "../../api";

export function TransferForm() {
  return <form onSubmit={() => sendTransfer("landlord", 900)}><button>Send</button></form>;
}

export default function NewTransfer() {
  return <TransferForm />;
}
