import { createFileRoute } from "@tanstack/react-router";
import { ChatsPage } from "@/components/chats/ChatsPage";

export const Route = createFileRoute("/chats")({
  head: () => ({ meta: [{ title: "Chats · Ruah" }] }),
  component: ChatsPage,
});
