// @ts-nocheck — fixture source (no node_modules); scanned, never compiled.
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import Welcome from "./routes/welcome";
import Home from "./routes/home";
import NewTransfer from "./routes/transfer/new";
import TransferDone from "./routes/transfer/done";
import Cards from "./routes/cards";

const router = createBrowserRouter([
  { path: "/", element: <Welcome /> },
  { path: "/home", element: <Home /> },
  {
    path: "/transfer",
    children: [
      { path: "new", element: <NewTransfer /> },
      { path: ":id/done", element: <TransferDone /> },
    ],
  },
  { path: "/cards", element: <Cards /> },
]);

createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
