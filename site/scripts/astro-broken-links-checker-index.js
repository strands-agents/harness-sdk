/**
 * Inlined from astro-broken-links-checker v1.0.6
 * Original source: https://github.com/imazen/astro-broken-link-checker
 * License: Apache-2.0
 * Author: Lilith River
 *
 * This file is a local copy of index.js from the plugin, modified to
 * allow custom behavior adjustments without forking the upstream package.
 */
import {fileURLToPath} from 'url';
import {join} from 'path';
import fs from 'fs';
import {checkLinksInHtml, normalizeHtmlFilePath} from './astro-broken-links-checker-check-links.js';
import fastGlob from 'fast-glob';
import pLimit from 'p-limit';

// Each in-flight page holds its parsed DOM until its links are checked, so peak heap scales with this.
const DEFAULT_PAGE_CONCURRENCY = 20;

export default function astroBrokenLinksChecker(options = {}) {
  const logFilePath = options.logFilePath || 'broken-links.log';
  const pageConcurrency = options.pageConcurrency || DEFAULT_PAGE_CONCURRENCY;
  const brokenLinksMap = new Map(); // Map of brokenLink -> Set of documents
  const checkedLinks = new Map();

  return {
    name: 'astro-broken-links-checker',
    hooks: {
      'astro:config:setup': async ({config}) => {
        //console.log('config.redirects', config.redirects);
        // save the redirects to the options
        options.astroConfigRedirects = config.redirects;

        // use astro trailingSlash setting, falling back to astro default of 'ignore'
        options.trailingSlash = config.trailingSlash || 'ignore';

        // capture base path so internal links can be resolved correctly
        // normalize to always have a leading slash and no trailing slash
        const rawBase = config.base || '/';
        options.basePath = rawBase === '/' ? '' : rawBase.replace(/\/$/, '');
      },

      'astro:build:done': async ({dir, logger}) => {
        const astroConfigRedirects = options.astroConfigRedirects;
        //console.log('astroConfigRedirects', astroConfigRedirects);
        const distPath = fileURLToPath(dir);
        const htmlFiles = await fastGlob('**/*.html', {cwd: distPath});
        logger.info(`Checking ${htmlFiles.length} html pages for broken links`);
        // start time
        const startTime = Date.now();
        const limit = pLimit(pageConcurrency);
        const checkHtmlPromises = htmlFiles.map((htmlFile) => limit(async () => {
          const absoluteHtmlFilePath = join(distPath, htmlFile);
          const htmlContent = fs.readFileSync(absoluteHtmlFilePath, 'utf8');
          const baseUrl = normalizeHtmlFilePath(absoluteHtmlFilePath, distPath);
          await checkLinksInHtml(
            htmlContent,
            brokenLinksMap,
            baseUrl,
            absoluteHtmlFilePath, // Document path
            checkedLinks,
            distPath,
            astroConfigRedirects,
            logger,
            options.checkExternalLinks,
            options.trailingSlash,
            options.basePath || '',
          );
        }));

        await Promise.all(checkHtmlPromises);
        logBrokenLinks(brokenLinksMap, logFilePath, logger);

        // end time
        const endTime = Date.now();
        logger.info(`Time to check links: ${endTime - startTime} ms`);

        // stop the build if we have broken links and the option is set
        if (options.throwError && brokenLinksMap.size > 0) {
          throw new Error(`Broken links detected. Check the log file: ${logFilePath}`);
        }
      },
    },
  };
}

function logBrokenLinks(brokenLinksMap, logFilePath, logger) {
  if (brokenLinksMap.size > 0) {
    let logData = '';
    for (const [brokenLink, documentsSet] of brokenLinksMap.entries()) {
      const documents = Array.from(documentsSet);
      logData += `Broken link: ${brokenLink}\n  Found in:\n`;
      for (const doc of documents) {
        logData += `    - ${doc}\n`;
      }
    }
    logData = logData.trim();
    if (logFilePath) {
      fs.writeFileSync(logFilePath, logData, 'utf8');
      logger.info(`Broken links have been logged to ${logFilePath}`);
      logger.info(logData);
    } else {
      logger.info(logData);
    }
  } else {
    logger.info('No broken links detected.');
    if (fs.existsSync(logFilePath)) {
      logger.info('Removing old log file:', logFilePath);
      fs.rmSync(logFilePath);
    }
  }
}
