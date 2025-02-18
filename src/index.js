const core = require('@actions/core');
const github = require('@actions/github');
const { getCoverageReport } = require('./parse');
const {
  getSummaryReport,
  getParsedXml,
  getNotSuccessTest,
} = require('./junitXml');
const { getMultipleReport } = require('./multiFiles');

const MAX_COMMENT_LENGTH = 65536;
const FILE_STATUSES = Object.freeze({
  ADDED: 'added',
  MODIFIED: 'modified',
  REMOVED: 'removed',
  RENAMED: 'renamed',
});

const main = async () => {
  const token = core.getInput('github-token', { required: true });
  const title = core.getInput('title', { required: false });
  const badgeTitle = core.getInput('badge-title', { required: false });
  const hideBadge = core.getBooleanInput('hide-badge', { required: false });
  const hideReport = core.getBooleanInput('hide-report', { required: false });
  const createNewComment = core.getBooleanInput('create-new-comment', {
    required: false,
  });
  const hideComment = core.getBooleanInput('hide-comment', { required: false });
  const reportOnlyChangedFiles = core.getBooleanInput(
    'report-only-changed-files',
    { required: false }
  );
  const defaultBranch = core.getInput('default-branch', { required: false });
  const covFile = core.getInput('pytest-coverage-path', { required: false });
  const pathPrefix = core.getInput('coverage-path-prefix', { required: false });
  const xmlFile = core.getInput('junitxml-path', { required: false });
  const xmlTitle = core.getInput('junitxml-title', { required: false });
  const multipleFiles = core.getMultilineInput('multiple-files', {
    required: false,
  });
  const { context, repository } = github;
  const { repo, owner } = context.repo;
  const { eventName, payload } = context;
  const WATERMARK = `<!-- Pytest Coverage Comment: ${context.job} -->\n`;
  let finalHtml = '';

  const options = {
    token,
    repository: repository || `${owner}/${repo}`,
    prefix: `${process.env.GITHUB_WORKSPACE}/`,
    pathPrefix,
    covFile,
    xmlFile,
    title,
    badgeTitle,
    hideBadge,
    hideReport,
    createNewComment,
    hideComment,
    reportOnlyChangedFiles,
    defaultBranch,
    xmlTitle,
    multipleFiles,
  };

  if (eventName === 'pull_request') {
    options.commit = payload.pull_request.head.sha;
    options.head = payload.pull_request.head.ref;
    options.base = payload.pull_request.base.ref;
  } else if (eventName === 'push') {
    options.commit = payload.after;
    options.head = context.ref;
  }

  if (options.reportOnlyChangedFiles) {
    const changedFiles = await getChangedFiles(options);
    options.changedFiles = changedFiles;
  }

  if (multipleFiles && multipleFiles.length) {
    finalHtml += getMultipleReport(options);
    core.setOutput('summaryReport', JSON.stringify(finalHtml));
  } else {
    let report = getCoverageReport(options);
    const { coverage, color, html, warnings } = report;
    const summaryReport = getSummaryReport(options);

    if (html) {
      const newOptions = { ...options, commit: defaultBranch };
      const output = getCoverageReport(newOptions);
      core.setOutput('coverageHtml', output.html);
    }

    // set to output junitxml values
    if (summaryReport) {
      const parsedXml = getParsedXml(options);
      const { errors, failures, skipped, tests, time } = parsedXml;
      const valuesToExport = { errors, failures, skipped, tests, time };

      Object.entries(valuesToExport).forEach(([key, value]) => {
        core.info(`${key}: ${value}`);
        core.setOutput(key, value);
      });

      const notSuccessTestInfo = getNotSuccessTest(options);
      core.setOutput('notSuccessTestInfo', JSON.stringify(notSuccessTestInfo));
      core.setOutput('summaryReport', JSON.stringify(summaryReport));
    }

    if (html.length + summaryReport.length > MAX_COMMENT_LENGTH) {
      // generate new html without report
      core.warning(
        `Your comment is too long (maximum is ${MAX_COMMENT_LENGTH} characters), coverage report will not be added.`
      );
      core.warning(
        `Try add: "--cov-report=term-missing:skip-covered", or add "hide-report: true", or add "report-only-changed-files: true", or switch to "multiple-files" mode`
      );
      report = getSummaryReport({ ...options, hideReport: true });
    }

    finalHtml += html;
    finalHtml += finalHtml.length ? `\n\n${summaryReport}` : summaryReport;

    if (coverage) {
      core.startGroup(options.covFile);
      core.info(`coverage: ${coverage}`);
      core.info(`color: ${color}`);
      core.info(`warnings: ${warnings}`);

      core.setOutput('coverage', coverage);
      core.setOutput('color', color);
      core.setOutput('warnings', warnings);
      core.endGroup();
    }
  }

  if (!finalHtml || options.hideComment) {
    core.info('Nothing to report');
    return;
  }
  const body = WATERMARK + finalHtml;
  const octokit = github.getOctokit(token);

  const issue_number = payload.pull_request ? payload.pull_request.number : 0;

  if (eventName === 'push') {
    core.info('Create commit comment');
    await octokit.repos.createCommitComment({
      repo,
      owner,
      commit_sha: options.commit,
      body,
    });
  }

  if (eventName === 'pull_request') {
    if (createNewComment) {
      core.info('Creating a new comment');

      await octokit.issues.createComment({
        repo,
        owner,
        issue_number,
        body,
      });
    } else {
      // Now decide if we should issue a new comment or edit an old one
      const { data: comments } = await octokit.issues.listComments({
        repo,
        owner,
        issue_number,
      });

      const comment = comments.find(
        (c) =>
          c.user.login === 'github-actions[bot]' && c.body.startsWith(WATERMARK)
      );

      if (comment) {
        core.info('Founded previous commit, updating');
        await octokit.issues.updateComment({
          repo,
          owner,
          comment_id: comment.id,
          body,
        });
      } else {
        core.info('No previous commit founded, creating a new one');
        await octokit.issues.createComment({
          repo,
          owner,
          issue_number,
          body,
        });
      }
    }
  }
};

// generate object of all files that changed based on commit through Github API
const getChangedFiles = async (options) => {
  try {
    const { context } = github;
    const { eventName, payload } = context;
    const { repo, owner } = context.repo;
    const octokit = github.getOctokit(options.token);

    // Define the base and head commits to be extracted from the payload
    let base, head;

    switch (eventName) {
      case 'pull_request':
        base = payload.pull_request.base.sha;
        head = payload.pull_request.head.sha;
        break;
      case 'push':
        base = payload.before;
        head = payload.after;
        break;
      default:
        core.setFailed(
          `This action only supports pull requests and pushes, ${eventName} events are not supported. ` +
            "Please submit an issue on this action's GitHub repo if you believe this in correct."
        );
    }

    core.startGroup('Changed files');
    // Log the base and head commits
    core.info(`Base commit: ${base}`);
    core.info(`Head commit: ${head}`);

    // Use GitHub's compare two commits API.
    // https://developer.github.com/v3/repos/commits/#compare-two-commits
    const response = await octokit.repos.compareCommits({
      base,
      head,
      owner,
      repo,
    });

    // Ensure that the request was successful.
    if (response.status !== 200) {
      core.setFailed(
        `The GitHub API for comparing the base and head commits for this ${eventName} event returned ${response.status}, expected 200. ` +
          "Please submit an issue on this action's GitHub repo."
      );
    }

    // Ensure that the head commit is ahead of the base commit.
    if (response.data.status !== 'ahead') {
      core.setFailed(
        `The head commit for this ${eventName} event is not ahead of the base commit. ` +
          "Please submit an issue on this action's GitHub repo."
      );
    }

    // Get the changed files from the response payload.
    const files = response.data.files;
    const all = [],
      added = [],
      modified = [],
      removed = [],
      renamed = [],
      addedModified = [];

    for (const file of files) {
      const { filename: filenameOriginal, status } = file;
      const filename = filenameOriginal.replace(options.pathPrefix, '');

      all.push(filename);

      switch (status) {
        case FILE_STATUSES.ADDED:
          added.push(filename);
          addedModified.push(filename);
          break;
        case FILE_STATUSES.MODIFIED:
          modified.push(filename);
          addedModified.push(filename);
          break;
        case FILE_STATUSES.REMOVED:
          removed.push(filename);
          break;
        case FILE_STATUSES.RENAMED:
          renamed.push(filename);
          break;
        default:
          core.setFailed(
            `One of your files includes an unsupported file status '${status}', expected ${Object.values(
              FILE_STATUSES
            ).join(',')}.`
          );
      }
    }

    core.info(`All: ${all.join(',')}`);
    core.info(`Added: ${added.join(', ')}`);
    core.info(`Modified: ${modified.join(', ')}`);
    core.info(`Removed: ${removed.join(', ')}`);
    core.info(`Renamed: ${renamed.join(', ')}`);
    core.info(`Added or modified: ${addedModified.join(', ')}`);

    core.endGroup();

    return {
      all: all,
      [FILE_STATUSES.ADDED]: added,
      [FILE_STATUSES.MODIFIED]: modified,
      [FILE_STATUSES.REMOVED]: removed,
      [FILE_STATUSES.RENAMED]: renamed,
      AddedOrModified: addedModified,
    };
  } catch (error) {
    core.setFailed(error.message);
  }
};

main().catch((err) => {
  core.error(err);
  core.setFailed(err.message);
});
