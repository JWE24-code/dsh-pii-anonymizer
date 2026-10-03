/**
 * Report unresolved SonarCloud issues for this project.
 *
 * The project is public, so SonarCloud serves its measures and issues without a
 * token. Existence is checked first through the measures endpoint: a project
 * that has never been analyzed has no measures, which is how a genuine "0
 * issues" is told apart from "never analyzed".
 *
 * Environment:
 *   SONAR_HOST_URL  optional, defaults to https://sonarcloud.io
 *
 * Usage: npm run sonar:issues
 */
const PROJECT_KEY = "JWE24-code_dsh-pii-anonymizer";
const HOST = process.env.SONAR_HOST_URL ?? "https://sonarcloud.io";
const PAGE_SIZE = 100;

/** Collapse external text to one bounded line so output cannot be log-injected. */
function oneLine(value) {
  return String(value)
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .slice(0, 500);
}

const measuresUrl = new URL("/api/measures/component", HOST);
measuresUrl.searchParams.set("component", PROJECT_KEY);
measuresUrl.searchParams.set("metricKeys", "bugs,vulnerabilities,code_smells");
const measuresResponse = await fetch(measuresUrl, { signal: AbortSignal.timeout(20_000) });
if (!measuresResponse.ok) {
  process.stderr.write(
    `${PROJECT_KEY}: no analysis found on ${HOST} (HTTP ${measuresResponse.status})\n`,
  );
  process.exit(2);
}

const issuesUrl = new URL("/api/issues/search", HOST);
issuesUrl.searchParams.set("componentKeys", PROJECT_KEY);
issuesUrl.searchParams.set("resolved", "false");
issuesUrl.searchParams.set("ps", String(PAGE_SIZE));
const issuesResponse = await fetch(issuesUrl, { signal: AbortSignal.timeout(20_000) });
if (!issuesResponse.ok) {
  process.stderr.write(`sonarcloud responded HTTP ${issuesResponse.status}\n`);
  process.exit(1);
}

const { total = 0, issues = [] } = await issuesResponse.json();
if (total === 0) {
  process.stdout.write(`${PROJECT_KEY}: 0 unresolved issues\n`);
  process.exit(0);
}

process.stdout.write(`${PROJECT_KEY}: ${Number(total) || 0} unresolved issue(s)\n`);
for (const issue of issues) {
  const file = oneLine(issue.component).split(":").pop();
  process.stdout.write(
    `  [${oneLine(issue.severity)}] ${oneLine(issue.type)} ` +
      `${file}:${oneLine(issue.line ?? "?")} ${oneLine(issue.rule)} — ${oneLine(issue.message)}\n`,
  );
}
process.exit(1);
