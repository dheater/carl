import * as fs from "fs";
import * as path from "path";

/**
 * Syncs the Homebrew formula with version, URL, and SHA256 from package.json and CLI args.
 * 
 * Usage:
 *   npx ts-node scripts/sync-homebrew-formula.ts --url <url> --sha256 <sha256>
 * 
 * Environment:
 *   - Reads version from package.json in cwd
 *   - Updates Formula/carl-ai.rb in cwd
 */

interface SyncOptions {
  url: string;
  sha256: string;
}

function parseArgs(): SyncOptions {
  const args = process.argv.slice(2);
  const options: Partial<SyncOptions> = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--url" && i + 1 < args.length) {
      options.url = args[i + 1];
      i++;
    } else if (args[i] === "--sha256" && i + 1 < args.length) {
      options.sha256 = args[i + 1];
      i++;
    }
  }

  if (!options.url || !options.sha256) {
    console.error("Error: Missing required arguments --url and --sha256");
    process.exit(1);
  }

  return options as SyncOptions;
}

function readPackageVersion(cwd: string): string {
  const pkgPath = path.join(cwd, "package.json");
  try {
    const content = fs.readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(content);
    return pkg.version;
  } catch (error) {
    console.error(`Error reading package.json: ${error}`);
    process.exit(1);
  }
}

function syncFormula(
  formulaPath: string,
  version: string,
  url: string,
  sha256: string
): string {
  let content: string;
  try {
    content = fs.readFileSync(formulaPath, "utf-8");
  } catch (error) {
    console.error(`Error reading formula: ${error}`);
    process.exit(1);
  }

  // Replace only the specific lines for version, url, and sha256
  // Use non-greedy matching to avoid replacing unrelated content
  content = content.replace(
    /^(\s*)url\s+"[^"]*"/m,
    `$1url "${url}"`
  );

  content = content.replace(
    /^(\s*)version\s+"[^"]*"/m,
    `$1version "${version}"`
  );

  content = content.replace(
    /^(\s*)sha256\s+"[^"]*"/m,
    `$1sha256 "${sha256}"`
  );

  return content;
}

function main() {
  const cwd = process.cwd();
  const options = parseArgs();
  const version = readPackageVersion(cwd);
  const formulaPath = path.join(cwd, "Formula", "carl-ai.rb");

  const syncedContent = syncFormula(formulaPath, version, options.url, options.sha256);

  try {
    fs.writeFileSync(formulaPath, syncedContent, "utf-8");
    console.log(`✓ Updated Formula/carl-ai.rb to version ${version}`);
  } catch (error) {
    console.error(`Error writing formula: ${error}`);
    process.exit(1);
  }
}

main();
