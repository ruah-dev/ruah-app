variable "name" {
  type = string
}

variable "instance_class" {
  type    = string
  default = "db.t4g.small"
}

variable "subnet_ids" {
  type = list(string)
}

variable "password" {
  type      = string
  sensitive = true
  default   = "FIXTURE-DEFAULT-PASSWORD-DO-NOT-LEAK"
}
