# Releasing

The pipeline is:

```
push → SonarCloud Automatic Analysis (0 issues) → CI tests → GitHub Release → npm → dshfind
```

## Prerequisites

### 1. SonarCloud (blocks all releases)

- Analysis is **Automatic Analysis** on the SonarCloud side: the project is
  public, so it needs no `SONAR_TOKEN` and no CI step.
- Check the gate with the project's own tool (no token needed; it confirms the
  project has actually been analyzed before trusting a clean result):

  ```sh
  npm run sonar:issues
  ```

  Exit `0` means zero unresolved issues; exit `1` prints them; exit `2` means the
  project has no analysis yet.

### 2. npm (first release only)

Trusted publishing requires the package to already exist on the registry, so the
**first** release needs one bootstrap path:

- publish once with a granular access token (`NPM_TOKEN` secret), **or**
- publish `v0.1.0` once from a machine that has run `npm login`.

After that, configure the trusted publisher once on npmjs.com:

> package → Settings → Trusted Publisher → GitHub → user `JWE24-code`,
> repository `dsh-pii-anonymizer`, workflow `publish.yml`, environment empty.

`.github/workflows/publish.yml` then publishes every later release over OIDC —
no long-lived token to rotate.

## Cutting a release

1. Bump `version` in `package.json`.
2. Commit and push; wait for CI to be green, including SonarCloud at **0**.
3. Create a GitHub Release whose tag matches the version exactly, e.g. `v0.1.0`
   (`publish.yml` fails the build if tag and manifest disagree).
4. `publish.yml` publishes to npm with `--provenance --access public`.

A manual `workflow_dispatch` run defaults to a dry run: it runs the gate and
packs the artifact without touching the registry.

## dshfind

dshfind indexes any public repository carrying the GitHub topic **`dsh-plugin`**.
The topic is set; its sync runs daily at **02:17 UTC**, so a new release appears
within about a day. Verify with:

```sh
curl -s "https://api.dshfind.com/v1/plugins/JWE24-code/dsh-pii-anonymizer"
curl -s "https://api.dshfind.com/v1/plugins?owner=JWE24-code"
```
