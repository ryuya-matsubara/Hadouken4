#!/usr/bin/env bash
#
# Deploy the Hadouken Battle static site to AWS (S3 + CloudFront).
#
# The site is served from a *private* S3 bucket that is reachable only through
# CloudFront via an Origin Access Control (OAC). This script is idempotent for
# the asset-sync + invalidation steps; the one-time infrastructure (bucket,
# OAC, distribution) is created only if it does not already exist.
#
# Usage:
#   ./deploy/deploy.sh            # sync assets + invalidate cache
#   BUCKET=my-bucket ./deploy/deploy.sh
#
# Requirements: awscli v2, valid AWS credentials (aws sts get-caller-identity).
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="${BUCKET:-hadouken3-${ACCOUNT_ID}-${REGION}}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "Account : ${ACCOUNT_ID}"
echo "Region  : ${REGION}"
echo "Bucket  : ${BUCKET}"

# --- 1. Bucket (private) ----------------------------------------------------
if ! aws s3api head-bucket --bucket "${BUCKET}" 2>/dev/null; then
  echo "Creating bucket ${BUCKET} ..."
  if [ "${REGION}" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "${BUCKET}" --region "${REGION}"
  else
    aws s3api create-bucket --bucket "${BUCKET}" --region "${REGION}" \
      --create-bucket-configuration LocationConstraint="${REGION}"
  fi
  aws s3api put-public-access-block --bucket "${BUCKET}" \
    --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
fi

# --- 2. Sync assets with correct content types ------------------------------
echo "Uploading assets ..."
aws s3 cp "${ROOT}/index.html" "s3://${BUCKET}/index.html" \
  --content-type "text/html; charset=utf-8" --cache-control "public, max-age=300"
aws s3 cp "${ROOT}/manifest.webmanifest" "s3://${BUCKET}/manifest.webmanifest" \
  --content-type "application/manifest+json" --cache-control "public, max-age=300"
for png in "${ROOT}"/*.png; do
  [ -e "${png}" ] || continue
  aws s3 cp "${png}" "s3://${BUCKET}/$(basename "${png}")" \
    --content-type "image/png" --cache-control "public, max-age=86400"
done

# --- 3. CloudFront cache invalidation (if a distribution exists) ------------
DIST_ID="$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?Origins.Items[?contains(DomainName, '${BUCKET}')]].Id | [0]" \
  --output text 2>/dev/null || true)"

if [ -n "${DIST_ID}" ] && [ "${DIST_ID}" != "None" ]; then
  echo "Invalidating CloudFront distribution ${DIST_ID} ..."
  aws cloudfront create-invalidation --distribution-id "${DIST_ID}" --paths "/*" \
    --query 'Invalidation.Id' --output text
  DOMAIN="$(aws cloudfront get-distribution --id "${DIST_ID}" \
    --query 'Distribution.DomainName' --output text)"
  echo "Site: https://${DOMAIN}/"
else
  echo "No CloudFront distribution found for this bucket."
  echo "See deploy/README.md for the one-time distribution + OAC setup."
fi

echo "Done."
