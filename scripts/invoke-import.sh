#!/usr/bin/env bash
set -euo pipefail
aws lambda invoke \
  --function-name R2FinanceFullImport \
  --cli-binary-format raw-in-base64-out \
  --payload '{}' \
  --region us-east-1 \
  /tmp/r2f-import-out.json
python3 -m json.tool /tmp/r2f-import-out.json
