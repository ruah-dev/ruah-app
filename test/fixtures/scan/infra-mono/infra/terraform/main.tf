terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    kubernetes = {
      source = "hashicorp/kubernetes"
    }
  }
}

provider "aws" {
  region = var.region
}

locals {
  cluster_name = "acme-prod"
}

# --- data ---------------------------------------------------------------

module "db" {
  source         = "./modules/postgres"
  name           = "acme-prod-db"
  instance_class = var.db_instance_class
  subnet_ids     = aws_subnet.private[*].id
}

resource "aws_s3_bucket" "assets" {
  bucket = "acme-assets"
  tags = {
    Name        = "acme-assets"
    Environment = "prod"
  }
}

resource "aws_s3_bucket_versioning" "assets" {
  bucket = aws_s3_bucket.assets.id
  versioning_configuration {
    status = "Enabled"
  }
}

# --- network (folded) -----------------------------------------------------

resource "aws_vpc" "main" {
  cidr_block = "10.20.0.0/16"
}

resource "aws_subnet" "private" {
  count      = 2
  vpc_id     = aws_vpc.main.id
  cidr_block = cidrsubnet(aws_vpc.main.cidr_block, 4, count.index)
}

# --- cluster --------------------------------------------------------------

resource "aws_eks_cluster" "main" {
  name     = local.cluster_name
  role_arn = aws_iam_role.eks.arn
  version  = "1.30"

  vpc_config {
    subnet_ids = aws_subnet.private[*].id
  }
}

resource "aws_eks_node_group" "default" {
  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "default"
  node_role_arn   = aws_iam_role.eks.arn
  subnet_ids      = aws_subnet.private[*].id
  scaling_config {
    desired_size = 3
    max_size     = 6
    min_size     = 2
  }
}

resource "aws_iam_role" "eks" {
  name               = "acme-eks"
  assume_role_policy = data.aws_iam_policy_document.eks_assume.json
}

resource "aws_iam_role_policy_attachment" "eks_cluster" {
  role       = aws_iam_role.eks.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
}

data "aws_iam_policy_document" "eks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
  }
}

# The worker reads its database settings from this Secret (envFrom db-credentials).
resource "kubernetes_secret" "db" {
  metadata {
    name      = "db-credentials"
    namespace = "prod"
  }
  data = {
    DATABASE_HOST     = module.db.address
    DATABASE_PASSWORD = random_password.db.result
  }
}

resource "random_password" "db" {
  length  = 32
  special = false
}

# --- edge ----------------------------------------------------------------

resource "aws_lb" "public" {
  name               = "acme-public"
  load_balancer_type = "application"
  subnets            = aws_subnet.private[*].id
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.public.arn
  port              = 443
  protocol          = "HTTPS"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

resource "aws_lb_target_group" "api" {
  name     = "acme-api"
  port     = 80
  protocol = "HTTP"
  vpc_id   = aws_vpc.main.id
}

resource "aws_route53_zone" "main" {
  name = "acme.dev"
}

resource "aws_route53_record" "api" {
  zone_id = aws_route53_zone.main.zone_id
  name    = "api.acme.dev"
  type    = "A"
  alias {
    name                   = aws_lb.public.dns_name
    zone_id                = aws_lb.public.zone_id
    evaluate_target_health = true
  }
}
