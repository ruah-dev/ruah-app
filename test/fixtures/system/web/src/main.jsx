import { createRoot } from "react-dom/client";
import { listInvoices } from "./api.js";

function App() {
  return <button onClick={() => listInvoices()}>Invoices</button>;
}

createRoot(document.getElementById("root")).render(<App />);
