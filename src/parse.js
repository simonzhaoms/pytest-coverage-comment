const core = require('@actions/core');
const { getPathToFile, getContentFile } = require('./utils');

// return true if "covergae file" include all special words
const isValidCoverageContent = (data) => {
  if (!data || !data.length) {
    return false;
  }

  const wordsToInclude = [
    'coverage: platform linux',
    'Stmts',
    'Miss',
    'Cover',
    'TOTAL',
  ];

  return wordsToInclude.every((w) => data.includes(w));
};

// return full html coverage report and coverage percenatge
const getCoverageReport = (options) => {
  const { covFile } = options;

  try {
    const covFilePath = getPathToFile(covFile);
    const content = getContentFile(covFilePath);
    const coverage = getTotalCoverage(content);
    const isValid = isValidCoverageContent(content);

    if (content && !isValid) {
      core.error(
        `Error: coverage file "${covFilePath}" has bad format or wrong data`
      );
    }

    if (content && isValid) {
      const html = toHtml(content, options);
      const total = getTotal(content);
      const warnings = getWarnings(content);
      const color = getCoverageColor(total ? total.cover : '0');

      return { html, coverage, color, warnings };
    }
  } catch (error) {
    core.error(`Generating coverage report. ${error.message}`);
  }

  return { html: '', coverage: '0', color: 'red', warnings: 0 };
};

// get coverage color
const getCoverageColor = (percentage) => {
  // https://shields.io/category/coverage
  const rangeColors = [
    {
      color: 'red',
      range: [0, 40],
    },
    {
      color: 'orange',
      range: [40, 60],
    },
    {
      color: 'yellow',
      range: [60, 80],
    },
    {
      color: 'green',
      range: [80, 90],
    },
    {
      color: 'brightgreen',
      range: [90, 101],
    },
  ];

  const num = parseFloat(percentage);

  const { color } =
    rangeColors.find(({ range: [min, max] }) => num >= min && num < max) ||
    rangeColors[0];

  return color;
};

// get actual lines from coverage-file
const getActualLines = (data) => {
  if (!data || !data.length) {
    return null;
  }

  const lines = data.split('\n');
  const startIndex = lines.findIndex((l) => l.includes('coverage: platform'));
  const endIndex = lines.findIndex((l) => l.includes('TOTAL '));
  if (startIndex === -1) {
    return null;
  }

  return lines.slice(startIndex + 3, endIndex - 1);
};

// get total line from coverage-file
const getTotal = (data) => {
  if (!data || !data.length) {
    return null;
  }

  const lines = data.split('\n');
  const line = lines.find((l) => l.includes('TOTAL     '));

  return parseTotalLine(line);
};

// get number of warnings from coverage-file
const getWarnings = (data) => {
  if (!data || !data.length) {
    return null;
  }

  const WARNINGS_KEY = ' warnings in ';
  if (!data.includes(WARNINGS_KEY)) {
    return 0;
  }

  const line = data.split('\n').find((l) => l.includes(WARNINGS_KEY));
  const lineArr = line.split(' ');
  const indexOfWarnings = lineArr.findIndex((i) => i === 'warnings');

  return parseInt(lineArr[indexOfWarnings - 1]);
};

// parse one line from coverage-file
const parseOneLine = (line) => {
  if (!line) {
    return null;
  }

  const parsedLine = line.split('   ').filter((l) => l);

  if (parsedLine.length < 4) {
    return null;
  }

  const lastItem = parsedLine[parsedLine.length - 1];
  const isFullCoverage = lastItem === '100%';
  const cover = isFullCoverage
    ? '100%'
    : parsedLine[parsedLine.length - 2].trimStart();
  const missing = isFullCoverage
    ? null
    : parsedLine[parsedLine.length - 1] &&
      parsedLine[parsedLine.length - 1].split(', ');

  return {
    name: parsedLine[0],
    stmts: parsedLine[1].trimStart(),
    miss: parsedLine[2].trimStart(),
    cover,
    missing,
  };
};

// parse total line from coverage-file
const parseTotalLine = (line) => {
  if (!line) {
    return null;
  }

  const parsedLine = line.split('   ').filter((l) => l);

  if (parsedLine.length < 4) {
    return null;
  }

  return {
    name: parsedLine[0],
    stmts: parsedLine[1].trimStart(),
    miss: parsedLine[2].trimStart(),
    cover: parsedLine[parsedLine.length - 1].trimStart(),
  };
};

// parse coverage-file
const parse = (data) => {
  const actualLines = getActualLines(data);

  if (!actualLines) {
    return null;
  }

  return actualLines.map(parseOneLine);
};

// collapse all lines to folders structure
const makeFolders = (coverage, options) => {
  const folders = {};

  for (const line of coverage) {
    const parts = line.name.replace(options.prefix, '').split('/');
    const folder = parts.slice(0, -1).join('/');

    folders[folder] = folders[folder] || [];
    folders[folder].push(line);
  }

  return folders;
};

// gets total coverage in percentage
const getTotalCoverage = (data) => {
  const total = getTotal(data);

  return total ? total.cover : '0';
};

// convert all data to html output
const toHtml = (data, options) => {
  const { badgeTitle, title, hideBadge, hideReport } = options;
  const table = hideReport ? '' : toTable(data, options);
  const total = getTotal(data);
  const color = getCoverageColor(total.cover);
  const readmeHref = `https://github.com/${options.repository}/blob/${options.commit}/README.md`;
  const badgeHtml = hideBadge
    ? ''
    : `<a href="${readmeHref}"><img alt="${badgeTitle}" src="https://img.shields.io/badge/${badgeTitle}-${total.cover}25-${color}.svg" /></a><br/>`;
  const reportHtml = hideReport
    ? ''
    : `<details><summary>${title}</summary>${table}</details>`;

  return `${badgeHtml}${reportHtml}`;
};

// make html table from coverage-file
const toTable = (data, options) => {
  const coverage = parse(data);

  if (!coverage) {
    core.warning(`Coverage file not well formed`);
    return null;
  }
  const totalLine = getTotal(data);
  options.hasMissing = coverage.some((c) => c.missing);

  core.info(`Generating coverage report`);
  const headTr = toHeadRow(options);

  const totalTr = toTotalRow(totalLine, options);

  const folders = makeFolders(coverage, options);

  const rows = Object.keys(folders)
    .sort()
    .filter((folderPath) => {
      if (!options.reportOnlyChangedFiles) {
        return true;
      }

      const allFilesInFolder = Object.values(folders[folderPath]).map(
        (f) => f.name
      );

      return allFilesInFolder.every((f) =>
        options.changedFiles.all.some((c) => c.includes(f))
      );
    })
    .reduce(
      (acc, key) => [
        ...acc,
        toFolderTd(key, options),
        ...folders[key].map((file) => toRow(file, key !== '', options)),
      ],
      []
    );

  return `<table>${headTr}<tbody>${rows.join('')}${totalTr}</tbody></table>`;
};

// make html head row - th
const toHeadRow = (options) => {
  const lastTd = options.hasMissing ? '<th>Missing</th>' : '';

  return `<tr><th>File</th><th>Stmts</th><th>Miss</th><th>Cover</th>${lastTd}</tr>`;
};

// make html row - tr
const toRow = (item, indent = false, options) => {
  const { stmts, miss, cover } = item;

  const name = toFileNameTd(item, indent, options);
  const missing = toMissingTd(item, options);
  const lastTd = options.hasMissing ? `<td>${missing}</td>` : '';

  return `<tr><td>${name}</td><td>${stmts}</td><td>${miss}</td><td>${cover}</td>${lastTd}</tr>`;
};

// make summary row - tr
const toTotalRow = (item, options) => {
  const { name, stmts, miss, cover } = item;
  const emptyCell = options.hasMissing ? '<td>&nbsp;</td>' : '';

  return `<tr><td><b>${name}</b></td><td><b>${stmts}</b></td><td><b>${miss}</b></td><td><b>${cover}</b></td>${emptyCell}</tr>`;
};

// make fileName cell - td
const toFileNameTd = (item, indent = false, options) => {
  const relative = item.name.replace(options.prefix, '');
  const href = `https://github.com/${options.repository}/blob/${options.commit}/${options.pathPrefix}${relative}`;
  const parts = relative.split('/');
  const last = parts[parts.length - 1];
  const space = indent ? '&nbsp; &nbsp;' : '';

  return `${space}<a href="${href}">${last}</a>`;
};

// make folder row - tr
const toFolderTd = (path, options) => {
  if (path === '') {
    return '';
  }

  const colspan = options.hasMissing ? 5 : 4;
  return `<tr><td colspan="${colspan}"><b>${path}</b></td></tr>`;
};

// make missing cell - td
const toMissingTd = (item, options) => {
  if (!item.missing) {
    return '&nbsp;';
  }

  return item.missing
    .map((range) => {
      const [start, end = start] = range.split('-');
      const fragment = start === end ? `L${start}` : `L${start}-L${end}`;
      const relative = item.name;
      const href = `https://github.com/${options.repository}/blob/${options.commit}/${options.pathPrefix}${relative}#${fragment}`;
      const text = start === end ? start : `${start}&ndash;${end}`;

      return `<a href="${href}">${text}</a>`;
    })
    .join(', ');
};

module.exports = { getCoverageReport };
