const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const cwd = process.cwd();
const changelogPath = path.resolve(cwd, process.env.CHANGELOG_FILE || "CHANGELOG.md");
const releaseNotesPath = path.resolve(cwd, process.env.RELEASE_NOTES_FILE || ".release-notes.md");
const packageJsonPath = path.resolve(cwd, "package.json");
const today = new Date().toISOString().slice(0, 10);

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const version = String(packageJson.version || "").trim();

if (!version) {
  throw new Error("package.json is missing a version field.");
}

const currentTag = `v${version}`;
const repoUrl = normalizeRepositoryUrl(runGit(["remote", "get-url", "origin"]));
const semverTagPattern = /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const existingTags = runGit(["tag", "--list", "v*", "--sort=-v:refname"])
  .split(/\r?\n/)
  .map((tag) => tag.trim())
  .filter((tag) => tag && semverTagPattern.test(tag));
const tagExists = existingTags.includes(currentTag);
const previousTag = existingTags.find((tag) => tag !== currentTag) || "";
const targetRef = tagExists ? currentTag : "HEAD";
const commitRange = previousTag ? `${previousTag}..${targetRef}` : targetRef;

const commits = runGit(["log", "--no-merges", "--pretty=format:%H%x1f%s%x1f%b%x1e", commitRange])
  .split("\x1e")
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const [sha, subject = "", description = ""] = entry.split("\x1f");
    return {
      sha,
      subject: subject.trim(),
      description: normalizeCommitDescription(description),
    };
  })
  .filter((commit) => commit.sha && commit.subject)
  .filter((commit) => !shouldIgnoreCommit(commit.subject));

const bulletLines = commits.length
  ? commits.map((commit) => formatCommit(commit, repoUrl)).join("\n")
  : "- No code changes recorded for this version.";

const compareUrl = previousTag && repoUrl ? `${repoUrl}/compare/${previousTag}...${currentTag}` : "";
const releaseUrl = repoUrl ? `${repoUrl}/releases/tag/${currentTag}` : "";
const headingUrl = compareUrl || releaseUrl;
const sectionHeading = headingUrl
  ? `## [${version}](${headingUrl}) - ${today}`
  : `## ${version} - ${today}`;
const changelogSection = `${sectionHeading}\n\n${bulletLines}\n`;
const releaseNotes = compactBlankLines(
  [
    `## ${version}`,
    "",
    bulletLines,
    compareUrl ? `**Full Changelog**: ${compareUrl}` : releaseUrl ? `**Release**: ${releaseUrl}` : "",
  ].join("\n"),
);

const existingChangelog = fs.existsSync(changelogPath)
  ? fs.readFileSync(changelogPath, "utf8")
  : "";
const nextChangelog = upsertChangelog(existingChangelog, version, changelogSection);
const changelogChanged = nextChangelog !== existingChangelog;

if (changelogChanged) {
  fs.mkdirSync(path.dirname(changelogPath), { recursive: true });
  fs.writeFileSync(changelogPath, ensureTrailingNewline(nextChangelog));
}

fs.mkdirSync(path.dirname(releaseNotesPath), { recursive: true });
fs.writeFileSync(releaseNotesPath, ensureTrailingNewline(releaseNotes));

setGithubOutput("version", version);
setGithubOutput("tag", currentTag);
setGithubOutput("previous_tag", previousTag);
setGithubOutput("tag_exists", String(tagExists));
setGithubOutput("changelog_changed", String(changelogChanged));
setGithubOutput("release_notes_file", releaseNotesPath);

process.stdout.write(
  `Prepared release metadata for ${currentTag} (${commits.length} commit${commits.length === 1 ? "" : "s"}).\n`,
);

function runGit(args) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const stderr = error.stderr ? String(error.stderr).trim() : "";
    throw new Error(`git ${args.join(" ")} failed${stderr ? `: ${stderr}` : "."}`);
  }
}

function normalizeRepositoryUrl(rawUrl) {
  if (!rawUrl) return "";
  const trimmed = rawUrl.trim();

  if (trimmed.startsWith("git@github.com:")) {
    return `https://github.com/${trimmed.slice("git@github.com:".length).replace(/\.git$/, "")}`;
  }

  if (trimmed.startsWith("ssh://git@github.com/")) {
    return `https://github.com/${trimmed.slice("ssh://git@github.com/".length).replace(/\.git$/, "")}`;
  }

  if (trimmed.startsWith("https://github.com/")) {
    return trimmed.replace(/\.git$/, "");
  }

  return "";
}

function shouldIgnoreCommit(subject) {
  return [
    /^docs\(changelog\):/i,
    /^chore\(release\):/i,
    /^release(\s|:)/i,
  ].some((pattern) => pattern.test(subject));
}

function formatCommit(commit, baseUrl) {
  const shortSha = commit.sha.slice(0, 7);
  const summaryLine = !baseUrl
    ? `- ${commit.subject} (${shortSha})`
    : `- ${commit.subject} ([${shortSha}](${baseUrl}/commit/${commit.sha}))`;

  if (!commit.description) {
    return summaryLine;
  }

  const descriptionLines = commit.description
    .split("\n")
    .map((line) => (line ? `  ${line}` : ""))
    .join("\n");

  return `${summaryLine}\n${descriptionLines}`;
}

function upsertChangelog(existingContent, currentVersion, section) {
  const versionPattern = new RegExp(
    `^##\\s+(?:\\[${escapeRegExp(currentVersion)}\\](?:\\(|\\s|$)|${escapeRegExp(currentVersion)}(?:\\s|$))`,
    "m",
  );

  if (versionPattern.test(existingContent)) {
    return existingContent;
  }

  const defaultHeader = "# Changelog\n\nAll notable changes to this project are documented in this file.\n";

  if (!existingContent.trim()) {
    return `${defaultHeader}\n${section}`.trimEnd();
  }

  if (!/^#\s+Changelog\b/m.test(existingContent)) {
    return `${defaultHeader}\n${section}\n${existingContent.trim()}`.trimEnd();
  }

  const firstVersionHeading = existingContent.match(/\n##\s+/);

  if (!firstVersionHeading) {
    return `${existingContent.trimEnd()}\n\n${section}`.trimEnd();
  }

  const insertIndex = firstVersionHeading.index + 1;
  const before = existingContent.slice(0, insertIndex).replace(/\s*$/, "\n\n");
  const after = existingContent.slice(insertIndex).trimStart();
  return `${before}${section}\n${after}`.trimEnd();
}

function compactBlankLines(value) {
  return value.replace(/\n{3,}/g, "\n\n").trim();
}

function normalizeCommitDescription(value) {
  return compactBlankLines(
    value
      .replace(/\r/g, "")
      .split("\n")
      .map((line) => line.trim())
      .join("\n"),
  );
}

function ensureTrailingNewline(value) {
  return `${value.replace(/\s+$/, "")}\n`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function setGithubOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) {
    return;
  }

  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${String(value)}\n`);
}
