/**
 * Inlined from astro-broken-links-checker v1.0.6
 * Original source: https://github.com/imazen/astro-broken-link-checker
 * License: Apache-2.0
 * Author: Lilith River
 *
 * This file is a local copy of check-links.js from the plugin, modified to
 * allow custom behavior adjustments without forking the upstream package.
 */
import {parse} from 'node-html-parser';
import fs from 'fs';
import fetch from 'node-fetch';
import {URL, fileURLToPath} from 'url';
import path from 'path';
import pLimit from 'p-limit';

export async function checkLinksInHtml(
  htmlContent,
  brokenLinksMap,
  baseUrl,
  documentPath,
  checkedLinks = new Map(),
  distPath = '',
  astroConfigRedirects = {},
  logger,
  checkExternalLinks = true,
  trailingSlash = 'ignore',
  basePath = '',
) {
  const root = parse(htmlContent);
  const linkElements = root.querySelectorAll('a[href]');
  const links = linkElements.map((el) => el.getAttribute('href'));
  // add img src
  const imgElements = root.querySelectorAll('img[src]');
  const imgLinks = imgElements.map((el) => el.getAttribute('src'));
  links.push(...imgLinks);

  const limit = pLimit(50);

  const checkLinkPromises = links.map((link) =>
    limit(async () => {
      if (!isValidUrl(link)) {
        return;
      }

      let absoluteLink;
      try {
        // Differentiate between absolute, domain-relative, and relative links
        if (/^https?:\/\//i.test(link) || /^:\/\//i.test(link)) {
          // Absolute URL
          absoluteLink = link;
        } else {
          absoluteLink = new URL(link, "https://localhost" + baseUrl).pathname;
          // if (link !== absoluteLink) {
          //   logger.info(`Link ${link} was resolved to ${absoluteLink}`);
          // }
        }
      } catch (err) {
        // Invalid URL, skip
        logger.error(`Invalid URL in ${normalizePath(documentPath)} ${link} ${err}`);
        return;
      }

      let fetchLink = link;
      if (absoluteLink.startsWith('/') && distPath) {
        fetchLink = absoluteLink;
      }

      // Strip the base path prefix from internal links so they resolve correctly
      // against the dist directory. e.g. /docs/page -> /page when base is /docs/
      let fetchLinkWithoutBase = fetchLink;
      if (basePath && fetchLink.startsWith(basePath)) {
        fetchLinkWithoutBase = fetchLink.slice(basePath.length) || '/';
      }

      // Redirect lookup uses the link without base prefix (redirects are defined without base)
      if (astroConfigRedirects[fetchLinkWithoutBase]) {
        const redirect = astroConfigRedirects[fetchLinkWithoutBase];
        if (redirect) {
          fetchLinkWithoutBase = redirect.destination ? redirect.destination : redirect;
          fetchLink = basePath + fetchLinkWithoutBase;
        }
      } else if (astroConfigRedirects[fetchLink]) {
        // fallback: try with full link including base
        const redirect = astroConfigRedirects[fetchLink];
        if (redirect) {
          fetchLink = redirect.destination ? redirect.destination : redirect;
          fetchLinkWithoutBase = basePath && fetchLink.startsWith(basePath)
            ? fetchLink.slice(basePath.length) || '/'
            : fetchLink;
        }
      }

      if (checkedLinks.has(fetchLink)) {
        const isBroken = !checkedLinks.get(fetchLink);
        if (isBroken) {
          addBrokenLink(brokenLinksMap, documentPath, link, distPath);
        }
        return;
      }

      let isBroken = false;

      if (fetchLink.startsWith('/') && distPath) {
        // Internal link in build mode, check if file exists.
        // Astro's base path is part of the URL but NOT reflected in the dist
        // directory structure — files are output at the root of dist/.
        // So we strip the base prefix and resolve against distPath directly.
        const relativePath = fetchLinkWithoutBase;
        // Potential file paths to check
        const possiblePaths = [
          path.join(distPath, relativePath),
          path.join(distPath, relativePath, 'index.html'),
          path.join(distPath, `${relativePath}.html`),
        ];

        // Check if any of the possible paths exist
        if (!possiblePaths.some((p) => fs.existsSync(p))) {
          // console.log('Failed paths', possiblePaths);
          isBroken = true;
          // Fall back to checking a redirect file if it exists.
        }

        // check trailing slash is correct on internal links
        const re = /\/$|\.[a-z0-9]+$/;  // match trailing slash or file extension
        if (trailingSlash === 'always' && !fetchLink.match(re)) {
          isBroken = true;
        } else if (trailingSlash === 'never' && fetchLink !== '/' && fetchLink.endsWith('/')) {
          isBroken = true;
        }
      } else {
        // External link, check via HTTP request. Retry 3 times if ECONNRESET
        if (checkExternalLinks) {
          let retries = 0;
          while (retries < 3) {
            try {
              const response = await fetch(fetchLink, {method: 'GET'});
              isBroken = !response.ok;
              if (isBroken) {
                logger.error(`${response.status} Error fetching ${fetchLink}`);
              }
              break;
            } catch (error) {
              isBroken = true;
              let statusCodeNumber = error.errno === 'ENOTFOUND' ? 404 : (error.errno);
              logger.error(`${statusCodeNumber} error fetching ${fetchLink}`);
              if (error.errno === 'ECONNRESET') {
                retries++;
                continue;
              }
              break;
            }
          }
        }
      }

      // Cache the link's validity
      checkedLinks.set(fetchLink, !isBroken);
      checkedLinks.set(absoluteLink, !isBroken);

      if (isBroken) {
        addBrokenLink(brokenLinksMap, documentPath, link, distPath);
      }
    })
  );

  await Promise.all(checkLinkPromises);
}

function isValidUrl(url) {
  // Skip non-HTTP schemes and empty links
  const lower = url.toLowerCase().trim();
  return !(
    lower.startsWith('mailto:') ||
    lower.startsWith('tel:') ||
    lower.startsWith('javascript:') ||
    lower.startsWith('vbscript:') ||
    lower.startsWith('data:') ||
    lower.startsWith('#') ||
    lower === ''
  );
}

function normalizePath(p) {
  p = p.toString();
  // Remove query parameters and fragments
  p = p.split('?')[0].split('#')[0];

  // Remove '/index.html' or '.html' suffixes
  if (p.endsWith('/index.html')) {
    p = p.slice(0, -'index.html'.length);
  } else if (p.endsWith('.html')) {
    p = p.slice(0, -'.html'.length);
  }

  // Ensure leading '/'
  if (!p.startsWith('/')) {
    p = '/' + p;
  }

  return p;
}

export function normalizeHtmlFilePath(filePath, distPath = '') {
  return normalizePath(distPath ? path.relative(distPath, filePath) : filePath);
}

function addBrokenLink(brokenLinksMap, documentPath, brokenLink, distPath) {
  // Normalize document path
  documentPath = normalizeHtmlFilePath(documentPath, distPath);

  // Normalize broken link for reporting
  let normalizedBrokenLink = brokenLink;

  if (!brokenLinksMap.has(normalizedBrokenLink)) {
    brokenLinksMap.set(normalizedBrokenLink, new Set());
  }
  brokenLinksMap.get(normalizedBrokenLink).add(documentPath);
}
