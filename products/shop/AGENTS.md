# Shop migration and release boundaries

Read `docs/ui-ux-principles.md` before changing customer-facing behaviour. Preserve the existing camera, upload, editor, product, cart, checkout and order-management journeys.

Use Bun for workspace installs and scripts. The isolated Lambda runtime image retains its own frozen npm dependency lock until its cloud qualification is deliberately migrated.

All AWS access must use `node scripts/aws-personal.mjs`. Its protected configuration pins the approved personal account, region, project SSO configuration and exact resources. Never use inherited credentials, the default credential chain, another profile or work AWS access. Authentication expiry is a stop.

Builds, deployment, infrastructure changes, release admission, qualification, drains, paired rollback and immutable artifacts remain in the protected GitHub Actions workflows. Moving source does not authorize a production deployment or replay of a historical recovery. Protected identities and historical recovery inputs must come from `SHOP_PROTECTED_CONFIG_JSON`; never commit them here.

For migration, dependency, infrastructure, workflow or release changes, run `bun run test:e2e:local` and `bun run check:ci` from this product before the final PR push. Draft/ready CI policy and full release qualification remain mandatory. Use a new full release lane for the first monorepo cutover; old repository receipts are not reusable as new evidence.
