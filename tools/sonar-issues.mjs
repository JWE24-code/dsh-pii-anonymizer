/**
 * List unresolved SonarCloud issues for this project.
 *
 * Requires `SONAR_TOKEN` (the same token the CI scan uses), because an
 * unauthenticated issue query returns an empty result both for a clean project
 * and for one that has never been analyzed — so it cannot be trusted as a gate.
 *
 * Environment:
 *   SONAR_TOKEN     required
 *   SONAR_HOST_URL  optional, defaults to https://sonarcloud.io
 *
 * Usage: npm run sonar:issues
 */
const PROJECT_KEY = "JWE24-code_dsh-pii-anonymizer";
const PAGE_SIZE = 100;

const token = process.env.SONAR_TOKEN;
if (!token) {
  console.error(
    "SONAR_TOKEN is required (a SonarCloud token with Analyze scope for org jwe24-code).",
  );
  console.error("Set it in the environment, or add it as a repository secret for CI.");
  process.exit(2);
}

const host = process.env.SONAR_HOST_URL ?? "https://sonarcloud.io";
const url = new URL("/api/issues/search", host);
url.searchParams.set("componentKeys", PROJECT_KEY);
url.searchParams.set("resolved", "false");
url.searchParams.set("ps", String(PAGE_SIZE));

const response = await fetch(url, {
  headers: { Authorization: `Basic ${Buffer.from(`${token}:`).toString("base64")}` },
  signal: AbortSignal.timeout(20_000),
});

if (!response.ok) {
  console.error(`sonarcloud responded ${response.status}`);
  console.error(await response.text());
  process.exit(1);
}

const { total, issues = [] } = await response.json();
if (total === 0) {
  console.log(`${PROJECT_KEY}: 0 unresolved issues`);
  process.exit(0);
}

console.log(`${PROJECT_KEY}: ${total} unresolved issue(s)`);
for (const issue of issues) {
  const file = issue.component.split(":").pop();
  console.log(
    `  [${issue.severity}] ${issue.type} ${file}:${issue.line ?? "?"} ${issue.rule} — ${issue.message}`,
  );
}
process.exit(1);
