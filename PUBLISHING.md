# Publishing

Releases are built by GitHub Actions from a version tag, so every npm version
matches a tag and carries npm provenance.

## First release (by hand)

A brand new npm package goes through npm's staged publishing: the first publish
creates a `0.0.0-stage` placeholder and your version waits for approval.

```sh
npm ci && npm run build && npm run lint && npm run typecheck && npm test
npm pack --dry-run        # check the file list
npm publish --access public
npm stage list mastra-weflayr
npm stage approve <stage-id>
```

Then make sure `latest` points at the new version:
`npm view mastra-weflayr dist-tags`.

## One time, for tagged releases

1. Create the repository `sholajegede/mastra-weflayr` on GitHub and push `main`.
2. Create an npm automation token that can publish `mastra-weflayr`.
3. Add it as the secret `NPM_TOKEN`, and create an environment named `npm`
   (add a required reviewer if you want a manual approval).
4. Turn on branch protection for `main`: require the `CI` checks and a pull
   request.

## Each release

```sh
npm version patch        # or minor, major, or prerelease --preid alpha
git push --follow-tags
```

The tag starts the **Release** workflow. It checks that the tag matches
`package.json`, runs build, lint, typecheck and tests, publishes to npm and opens
a GitHub release. A tag with a dash, such as `v0.2.0-alpha.0`, publishes under
the `next` tag.

## Versioning

- Patch: fixes with no change to the public API.
- Minor: new methods or options.
- Major: anything that breaks an app that already uses the package. Below 1.0, a
  minor version may break, and the CHANGELOG says so.
