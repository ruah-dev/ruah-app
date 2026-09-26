// src/projects/templates/infra.ts — "Infra (Terraform + GitHub Actions)".
// Provider-agnostic on purpose: the only resource is the built-in
// `terraform_data`, so `terraform init` / `plan` work offline and create
// nothing in any cloud. The workflow checks formatting, validates and plans on
// pull requests; it never applies.
import { dedent, gitignore, jsString, type ProjectTemplate } from "./types.js";

export const infraTemplate: ProjectTemplate = {
  id: "infra-terraform",
  name: "Infra (Terraform + GitHub Actions)",
  description: "Terraform with dev / prod variables and a GitHub Actions workflow that checks, validates and plans (never applies).",
  run: "cd terraform && terraform init && terraform plan",
  setupPrompt:
    "Set up the project: explain the Terraform layout and the GitHub Actions workflow, run `terraform fmt -check` and `terraform validate` if Terraform is installed, then ask me which cloud provider and resources we need. Never run `terraform apply`.",
  scan: true,
  files: ({ name, slug }) => ({
    "terraform/versions.tf": dedent(`
      terraform {
        required_version = ">= 1.6.0"

        # Add your provider here, e.g.:
        # required_providers {
        #   aws = { source = "hashicorp/aws", version = "~> 5.0" }
        # }

        # Remote state (recommended once more than one person applies):
        # backend "s3" {}
      }
    `),
    "terraform/variables.tf": dedent(`
      variable "project" {
        description = "Project name, used in names and tags."
        type        = string
        default     = ${jsString(slug)}
      }

      variable "environment" {
        description = "Deployment environment."
        type        = string
        default     = "dev"

        validation {
          condition     = contains(["dev", "staging", "prod"], var.environment)
          error_message = "environment must be dev, staging or prod."
        }
      }
    `),
    "terraform/main.tf": dedent(`
      locals {
        name = "\${var.project}-\${var.environment}"
        tags = {
          project     = var.project
          environment = var.environment
          managed-by  = "terraform"
        }
      }

      # A placeholder that needs no provider: replace it with real resources.
      resource "terraform_data" "release" {
        input = {
          name = local.name
          tags = local.tags
        }
      }
    `),
    "terraform/outputs.tf": dedent(`
      output "name" {
        description = "The environment's resource name prefix."
        value       = local.name
      }

      output "tags" {
        description = "Tags every resource should carry."
        value       = local.tags
      }
    `),
    "terraform/environments/dev.tfvars.example": dedent(`
      # Copy to dev.tfvars (ignored by git) and pass it with -var-file.
      environment = "dev"
    `),
    "terraform/environments/prod.tfvars.example": dedent(`
      environment = "prod"
    `),
    ".github/workflows/terraform.yml": dedent(`
      name: terraform

      on:
        pull_request:
          paths: ["terraform/**", ".github/workflows/terraform.yml"]
        push:
          branches: [main]
          paths: ["terraform/**", ".github/workflows/terraform.yml"]

      permissions:
        contents: read

      jobs:
        check:
          runs-on: ubuntu-latest
          defaults:
            run:
              working-directory: terraform
          steps:
            - uses: actions/checkout@v4
            - uses: hashicorp/setup-terraform@v3
            - name: Format
              run: terraform fmt -check -recursive
            - name: Init
              run: terraform init -input=false
            - name: Validate
              run: terraform validate
            - name: Plan
              if: github.event_name == 'pull_request'
              run: terraform plan -input=false -no-color
    `),
    Makefile: dedent(`
      TF := terraform -chdir=terraform

      .PHONY: init fmt validate plan

      init:
      \t$(TF) init

      fmt:
      \t$(TF) fmt -recursive

      validate: init
      \t$(TF) validate

      plan: init
      \t$(TF) plan
    `),
    "README.md": dedent(`
      # ${name}

      Infrastructure as code: Terraform plus a GitHub Actions workflow.

      \`\`\`sh
      make init       # terraform init (no provider yet: works offline)
      make plan       # terraform plan
      make fmt validate
      \`\`\`

      - \`terraform/\` — versions, variables, resources, outputs
      - \`terraform/environments/*.tfvars.example\` — per-environment values (copy to \`*.tfvars\`, which git ignores)
      - \`.github/workflows/terraform.yml\` — fmt check, validate and plan on pull requests; **it never applies**

      Apply from your machine (or add a protected, manual workflow) once a provider and a remote state are set up.
    `),
    ".gitignore": gitignore([".terraform/", "*.tfstate", "*.tfstate.*", "crash.log", "crash.*.log", "*.tfvars", "!*.tfvars.example", "override.tf", "override.tf.json", "*_override.tf"]),
  }),
};
