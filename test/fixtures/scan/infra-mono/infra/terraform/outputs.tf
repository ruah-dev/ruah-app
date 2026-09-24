output "db_endpoint" {
  value = module.db.address
}

output "cluster_endpoint" {
  value = aws_eks_cluster.main.endpoint
}
