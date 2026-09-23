import { createFileRoute } from "@tanstack/react-router";
import { TasksPage } from "@/components/orchestration/TasksPage";

export const Route = createFileRoute("/tasks")({
  head: () => ({ meta: [{ title: "Tasks · Ruah" }] }),
  component: TasksPage,
});
