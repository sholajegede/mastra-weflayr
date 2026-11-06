# Security

## Report a problem

Report a vulnerability in private through
[GitHub security advisories](https://github.com/sholajegede/mastra-weflayr/security/advisories/new).
Please do not open a public issue. You get a first reply within three working
days.

## Supported versions

Only the latest minor version gets fixes while the package is below 1.0.

## How the package handles secrets and data

- The Weflayr API key is read from `WEFLAYR_API_KEY` or the `apiKey` option and
  sent to the gateway as the bearer key. The package never logs it or writes it
  anywhere.
- The package stores nothing itself. Spend is kept in the `SpendStore` you give
  it (memory by default). It holds customer ids and dollar amounts, never
  prompts or answers.
- Customer ids, plan and run ids go to Weflayr in the `x-weflayr-metadata`
  header. Use an id, not an email address or a full name.
- The processors read token counts from Mastra. They do not read message text.

## For maintainers

- npm releases are built by CI with provenance, from a version tag. See
  [PUBLISHING.md](./PUBLISHING.md).
- CodeQL runs on every push and weekly. Pull requests get a dependency review.
