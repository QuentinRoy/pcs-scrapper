const puppeteer = require('puppeteer');
const log = require('loglevel');
const pluralize = require('pluralize');
const { promisify } = require('util');
const fs = require('fs');
const pkg = require('./package.json');

const writeFile = promisify(fs.writeFile);
const readFile = promisify(fs.readFile);

const CREDENTIAL_FILE = 'creds.json';
const OUTPUT_FILE = 'reviews.json';

log.setLevel('info');

/**
 * @param {Page} loginPage The login page.
 * @param {string} username The username.
 * @param {string} password The password.
 * @return {Promise<Page>} The main page (after login).
 */
const logIn = async (loginPage, username, password) => {
  await loginPage.click('input[name=userLoginID]');
  await loginPage.keyboard.type(username);
  await loginPage.click('input[name=password]');
  await loginPage.keyboard.type(password);
  await loginPage.keyboard.press('Enter');
  await loginPage.waitForNavigation({ waitUntil: 'domcontentloaded' });
  return loginPage;
};

/**
 * Scrape the submission categories.
 *
 * @param {Page} mainReviewsPage Page of the submissions categories (myHome on
 * precision conference).
 * @return {Promise<[{ name, link, address, row }]>} A promise that resolves
 * with an array with the submission categories.
 */
const scrapeSubmissionCategories = mainReviewsPage =>
  // Fetch all the links to review categories (e.g. conferences). We look for
  // links to avoid selecting the empty tds.
  mainReviewsPage.$$eval('h1 + div table td a', links =>
    Array.from(links)
      // Query their properties.
      .map(link => ({
        name: link.parentNode.parentNode.querySelector('td').innerText,
        address: link.href,
      })),
  );

/**
 * Scrape a submission.
 *
 * @param {Browser} browser The browser.
 * @param {string} reviewPageAddress The address of the review page.
 * @param {boolean} isUser True if this review is the one of the logged in user.
 * @return {Promise<[{}]>} A promise that resolves with the review's info.
 */
const scrapeSubmissionReview = async (browser, reviewPageAddress, isUser) => {
  const reviewPage = await browser.newPage();
  await reviewPage.goto(reviewPageAddress, {
    waitUntil: 'domcontentloaded',
  });
  const result = await reviewPage.$eval('body', body => {
    // Scrape interesting content from the page..
    const [reviewerTd, , ratingTd, expertiseTd] = Array.from(
      body.querySelectorAll('table:nth-of-type(2) tr'),
    ).map(tr => tr.querySelector('td:nth-of-type(2)'));

    // Apply some regexp.
    const reviewerMatch = /\(([^)]+)\)/.exec(reviewerTd.innerText);
    const ratingScaleMatch = /scale is (\d(?:\.\d)?)\.\.(\d(?:\.\d)?)/.exec(
      ratingTd.innerText,
    );
    const expertiseScaleMatch = /scale is (\d(?:\.\d)?)\.\.(\d(?:\.\d)?)/.exec(
      expertiseTd.innerText,
    );

    // Scrap the review parts (including titles)
    const reviewTrs = body.querySelectorAll(
      'table:nth-of-type(3) > tbody > tr',
    );
    const reviewParts = Array.from(reviewTrs)
      .filter((x, i) => i % 2 === 0)
      .map((title, i) => ({
        title: title.innerText ? title.innerText.trim() : null,
        content: reviewTrs[i * 2 + 1]
          ? reviewTrs[i * 2 + 1].innerText.trim()
          : null,
      }))
      .filter(({ title }) => title !== '');

    return {
      number: +reviewerTd.querySelector('b').innerText,
      rating: +ratingTd.querySelector('b').innerText,
      ratingScale: ratingScaleMatch
        ? ratingScaleMatch.slice(1, 3).map(x => +x)
        : null,
      reviewerExpertise: +expertiseTd.querySelector('b').innerText,
      expertiseScale: expertiseScaleMatch
        ? expertiseScaleMatch.slice(1, 3).map(x => +x)
        : null,
      reviewerType: reviewerMatch ? reviewerMatch[1] : 'external',
      reviewParts,
    };
  });
  await reviewPage.close();
  return Object.assign({ isUser }, result);
};

/**
 * Scrape a submission.
 *
 * @param {Browser} browser The browser.
 * @param {string} submissionPageAddress The address of the submission page.
 * @return {Promise<[{}]>} A promise that resolves with the submission's reviews.
 */
const scrapeSubmissionReviews = async (browser, submissionPageAddress) => {
  // Scrape the review addresses.
  const submissionPage = await browser.newPage();
  await submissionPage.goto(submissionPageAddress, {
    waitUntil: 'domcontentloaded',
  });
  const reviewAddresses = await submissionPage.$$eval(
    '#wrap > h1:nth-of-type(2) + blockquote table tr a',
    links =>
      Array.from(links).map(link => ({
        address: link.href,
        isUser: link.innerText.includes('(you)'),
      })),
  );
  await submissionPage.close();
  // Scrape the reviews.
  return Promise.all(
    reviewAddresses.map(review =>
      scrapeSubmissionReview(browser, review.address, review.isUser),
    ),
  );
};

/**
 * Scrape the submissions of a submission category.
 *
 * @param {Browser} browser The browser.
 * @param {string} submissionsPageAddress The address of the submissions page.
 * @return {Promise<[{ id, title, submissionAddress, reviewsAddress, reviewStatus, award, coordinator, reviews }]>}
 * A promise that resolves with an array with the submissions' information.
 */
const scrapeSubmissions = async (browser, submissionsPageAddress) => {
  // Scrape the submission list.
  const catPage = await browser.newPage();
  await catPage.goto(submissionsPageAddress, {
    waitUntil: 'domcontentloaded',
  });
  const submissions = await catPage.$$eval(
    'h1 + blockquote table tr:nth-child(n + 4)',
    trs =>
      // Fetch the table row of each submission.
      Array.from(trs)
        // Query their properties.
        .map(tr => {
          const tds = tr.querySelectorAll('td');
          const coordinatorMatch = /\(([^)]+)\)/.exec(tds[14].innerText);
          return {
            id: tds[6].innerText,
            title: tds[8].querySelector('a').title,
            submissionAddress: tds[8].querySelector('a').href,
            reviewsAddress: tds[12].querySelector('a').href,
            reviewStatus: tds[0].innerText,
            coordinator: coordinatorMatch ? coordinatorMatch[1] : undefined,
          };
        }),
  );
  await catPage.close();
  // Scrape the submission reviews.
  return Promise.all(
    submissions.map(async sub =>
      Object.assign({}, sub, {
        reviews: await scrapeSubmissionReviews(browser, sub.reviewsAddress),
      }),
    ),
  );
};

/**
 * Main function of the script.
 *
 * @return {Promise} A promise resolved when the scrapping is done.
 */
const main = async () => {
  // Start up.
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  log.info('Loading precisionconference.com/~sigchi...');
  await page.goto('https://precisionconference.com/~sigchi', {
    waitUntil: 'domcontentloaded',
  });

  // Log in.
  const creds = JSON.parse(await readFile(CREDENTIAL_FILE));
  log.info(`Logging as ${creds.username}.`);
  await logIn(page, creds.username, creds.password);

  // Fetch the review categories.
  log.info('Look for reviews...');
  const categories = await scrapeSubmissionCategories(page);
  log.info(
    `Found ${categories.length} review ${pluralize(
      'category',
      categories.length,
    )}: ${categories.map(c => c.name).join(', ')}.`,
  );

  // Scrape the submissions of each submission categhories
  log.info('Scrape reviews...');
  const reviewCategories = await Promise.all(
    categories.map(async cat =>
      Object.assign({}, cat, {
        submissions: await scrapeSubmissions(browser, cat.address),
      }),
    ),
  );

  // Write the result.
  await writeFile(
    OUTPUT_FILE,
    JSON.stringify(
      {
        scrapper: pkg.name,
        version: pkg.version,
        username: creds.username,
        date: new Date(),
        reviewCategories,
      },
      null,
      2,
    ),
  );
  log.info(`Data written in ${OUTPUT_FILE}.`);

  // Clean up.
  await browser.close();
};

main().catch(e => {
  log.error(e);
  process.exit(0);
});
