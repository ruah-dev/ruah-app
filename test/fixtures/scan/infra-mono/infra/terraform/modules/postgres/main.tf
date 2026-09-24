resource "aws_db_subnet_group" "this" {
  name       = "${var.name}-subnets"
  subnet_ids = var.subnet_ids
}

resource "aws_db_instance" "this" {
  identifier           = var.name
  engine               = "postgres"
  engine_version       = "16.3"
  instance_class       = var.instance_class
  allocated_storage    = 50
  multi_az             = true
  db_subnet_group_name = aws_db_subnet_group.this.name
  username             = "acme"
  password             = var.password
  skip_final_snapshot  = false
}
