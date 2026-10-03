/**
 * Register this package as an enabled bundle in one DSH profile manifest.
 *
 * The moqi-tui `/plugins` picker reads a profile's `package.json` (its
 * `dependencies` and `dsh.profile.bundles`), not the Cordis loader, so a plugin
 * installed only via a patch layer is invisible there. This makes it a real,
 * listed bundle.
 *
 * Only a directory directly under `<DSH_HOME>/profiles` is ever touched: the
 * argument is reduced to its final path segment, so a crafted value such as
 * `../../etc` cannot traverse out of the profiles root.
 *
 * Usage: node tools/register-profile.mjs <profileName|profileDir>
 */
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const requested = process.argv[2];
if (!requested) {
  console.error("usage: register-profile.mjs <profileName|profileDir>");
  process.exit(2);
}

const NAME = "dsh-pii-anonymizer";
const SPEC = "link:/home/joeri/Projects/dsh-pii-anonymizer";
const BASE = "@deepseek-ai/dsh-base";

const profileName = basename(requested);
if (profileName === "" || profileName === "." || profileName === "..") {
  console.error(`${JSON.stringify(requested)} is not a profile name`);
  process.exit(2);
}

const profilesRoot = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "profiles");
const pkgPath = join(profilesRoot, profileName, "package.json");
const manifest = JSON.parse(readFileSync(pkgPath, "utf8"));

copyFileSync(pkgPath, `${pkgPath}.bak`);

manifest.dependencies = { ...manifest.dependencies, [NAME]: SPEC };

const dsh = (manifest.dsh ??= {});
const profile = (dsh.profile ??= {});
const bundles = Array.isArray(profile.bundles) ? profile.bundles : [];
const rest = bundles.filter((bundle) => bundle !== BASE && bundle !== NAME);
const hadBase = bundles.includes(BASE);
profile.bundles = [...(hadBase ? [BASE] : []), ...rest, NAME];

writeFileSync(pkgPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`registered ${NAME} in ${pkgPath}`);
