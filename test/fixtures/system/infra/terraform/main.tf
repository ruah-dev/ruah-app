resource "aws_ecs_task_definition" "web" {
  family = "web"
  container_definitions = jsonencode([{
    name  = "web"
    image = "ghcr.io/acme/web:2.0"
  }])
}
