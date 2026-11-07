# bent.build monorepo

Use Bun for dependency management and scripts. Keep one root bun.lock. Existing products retain their runtime and internal package boundaries.

Keep application imports scoped to deployments on bent.build and its subdomains.

This repository is public. Never commit credentials, private content, household or vehicle information, source photos, operational exports, local state, or private deployment records. Use synthetic fixtures and protected configuration. Imported private repositories must use audited source snapshots, never their Git histories.

Write public documentation, interface text, metadata and PR copy around current features, behavior and required actions. Keep internal scope decisions and migration commentary in private task notes. Use plain, affirmative descriptions while preserving precise error guidance, legal meaning and authorization requirements. Apply the unslop writing guidance before publishing.

Shared design tokens live in packages/design-tokens and shared React controls in packages/ui. Product authentication, storage, routing and business logic remain with their applications. Preserve app-specific instructions and authorization boundaries.

Run affected application checks and the public-source audit before publishing. Shared package changes require validation of their consumers. Preserve all existing application quality, independent review, security and release gates. Production deployment requires the established guarded release route and qualification; moving source does not authorize bypassing it.

Use pull requests, conventional commits and independent Sol review of the final head against the current base. Never bypass protections or fabricate review statuses. Preserve original source attribution through SOURCE_PROVENANCE.json.

Keep the blog's existing CodeQL rule of zero raw findings, including flows involving the blog or shared packages. The new Shop analysis may record individually investigated, intentional network/file flows and fixed-origin requests in .github/codeql/reviewed-flows.json. Unknown findings, vulnerabilities, changed source or guard/test/configuration inputs, changed traces, and stale or ambiguous records must fail. Keep every query and the original SARIF report. A disposition record is evidence for review, never approval: independent Sol review must cover the exact final head, current base, gate and records before native false-positive dismissal or merge. Do not automate privileged alert dismissal from PR-supplied records.
