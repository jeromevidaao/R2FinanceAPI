#!/usr/bin/env bash
# Deploy R2FinanceAPI Lambdas + HTTP API + EventBridge schedule.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
REGION="${AWS_REGION:-us-east-1}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
ROLE_ARN="arn:aws:iam::${ACCOUNT}:role/R2FinanceLambdaRole"
RUNTIME="nodejs20.x"
ZIP="/tmp/r2finance-api.zip"

echo "npm install --omit=dev"
npm install --omit=dev

rm -f "$ZIP"
# Package handlers + lib + node_modules
zip -qr "$ZIP" package.json src node_modules -x 'node_modules/.cache/*'
ls -lh "$ZIP"

deploy_fn() {
  local name="$1"
  local handler="$2"
  local timeout="${3:-120}"
  local memory="${4:-512}"
  if aws lambda get-function --function-name "$name" --region "$REGION" >/dev/null 2>&1; then
    echo "Update $name"
    aws lambda update-function-code \
      --function-name "$name" \
      --zip-file "fileb://$ZIP" \
      --region "$REGION" >/dev/null
    aws lambda wait function-updated --function-name "$name" --region "$REGION"
    aws lambda update-function-configuration \
      --function-name "$name" \
      --runtime "$RUNTIME" \
      --handler "$handler" \
      --timeout "$timeout" \
      --memory-size "$memory" \
      --role "$ROLE_ARN" \
      --environment "Variables={R2FINANCE_TABLE=R2Finance,YNAB_SECRET_ID=R2Finance/ynab-pat,R2FINANCE_PLAN_ID=default,R2FINANCE_WEBSITE_URL=https://finance.i-liquid.be,R2FINANCE_RESET_FROM=no-reply@i-liquid.be}" \
      --region "$REGION" >/dev/null
  else
    echo "Create $name"
    aws lambda create-function \
      --function-name "$name" \
      --runtime "$RUNTIME" \
      --role "$ROLE_ARN" \
      --handler "$handler" \
      --timeout "$timeout" \
      --memory-size "$memory" \
      --zip-file "fileb://$ZIP" \
      --environment "Variables={R2FINANCE_TABLE=R2Finance,YNAB_SECRET_ID=R2Finance/ynab-pat,R2FINANCE_PLAN_ID=default,R2FINANCE_WEBSITE_URL=https://finance.i-liquid.be,R2FINANCE_RESET_FROM=no-reply@i-liquid.be}" \
      --tags "Project=R2Finance" \
      --region "$REGION" >/dev/null
  fi
  aws lambda wait function-updated --function-name "$name" --region "$REGION" 2>/dev/null || true
}

# Higher timeout/memory: full txn hydrate is ~3MB+ and DDB query of 7k+ rows.
deploy_fn R2FinanceApiHandler src/handlers/apiHandler.handler 60 1024
deploy_fn R2FinanceYnabPull src/handlers/ynabPull.handler 120 512
deploy_fn R2FinanceYnabPush src/handlers/ynabPush.handler 60 256
deploy_fn R2FinanceFullImport src/handlers/fullImport.handler 300 1024

# EventBridge schedule every 15 minutes for pull+push tick
RULE=R2FinanceYnabPullSchedule
aws events put-rule \
  --name "$RULE" \
  --schedule-expression "rate(15 minutes)" \
  --state ENABLED \
  --description "R2Finance YNAB delta pull + push pending" \
  --region "$REGION" >/dev/null

PULL_ARN="$(aws lambda get-function --function-name R2FinanceYnabPull --query Configuration.FunctionArn --output text --region "$REGION")"
aws lambda add-permission \
  --function-name R2FinanceYnabPull \
  --statement-id R2FinanceYnabPullSchedule \
  --action lambda:InvokeFunction \
  --principal events.amazonaws.com \
  --source-arn "arn:aws:events:${REGION}:${ACCOUNT}:rule/${RULE}" \
  --region "$REGION" 2>/dev/null || true

aws events put-targets \
  --rule "$RULE" \
  --targets "Id=1,Arn=${PULL_ARN}" \
  --region "$REGION" >/dev/null

# HTTP API Gateway
API_ID="$(aws apigatewayv2 get-apis --region "$REGION" --query "Items[?Name=='R2FinanceAPI'].ApiId | [0]" --output text)"
if [ "$API_ID" = "None" ] || [ -z "$API_ID" ]; then
  API_ID="$(aws apigatewayv2 create-api \
    --name R2FinanceAPI \
    --protocol-type HTTP \
    --cors-configuration AllowOrigins='*',AllowMethods='GET,POST,PATCH,OPTIONS',AllowHeaders='authorization,content-type' \
    --region "$REGION" \
    --query ApiId --output text)"
  echo "Created API $API_ID"
else
  echo "Existing API $API_ID"
fi

API_HANDLER_ARN="$(aws lambda get-function --function-name R2FinanceApiHandler --query Configuration.FunctionArn --output text --region "$REGION")"
INT_ID="$(aws apigatewayv2 get-integrations --api-id "$API_ID" --region "$REGION" --query "Items[0].IntegrationId" --output text 2>/dev/null || true)"
if [ "$INT_ID" = "None" ] || [ -z "$INT_ID" ]; then
  INT_ID="$(aws apigatewayv2 create-integration \
    --api-id "$API_ID" \
    --integration-type AWS_PROXY \
    --integration-uri "$API_HANDLER_ARN" \
    --payload-format-version 2.0 \
    --region "$REGION" \
    --query IntegrationId --output text)"
fi

# Catch-all route
aws apigatewayv2 create-route --api-id "$API_ID" --route-key 'ANY /{proxy+}' --target "integrations/${INT_ID}" --region "$REGION" 2>/dev/null || true
aws apigatewayv2 create-route --api-id "$API_ID" --route-key 'ANY /' --target "integrations/${INT_ID}" --region "$REGION" 2>/dev/null || true
aws apigatewayv2 create-stage --api-id "$API_ID" --stage-name '$default' --auto-deploy --region "$REGION" 2>/dev/null || true

aws lambda add-permission \
  --function-name R2FinanceApiHandler \
  --statement-id R2FinanceAPIInvoke \
  --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:${REGION}:${ACCOUNT}:${API_ID}/*" \
  --region "$REGION" 2>/dev/null || true

ENDPOINT="$(aws apigatewayv2 get-api --api-id "$API_ID" --region "$REGION" --query ApiEndpoint --output text)"
echo "API endpoint: $ENDPOINT"
echo "$ENDPOINT" > "$ROOT/.api-endpoint"
echo "Deploy complete."
