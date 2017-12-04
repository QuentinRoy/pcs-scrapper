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
 * Fetch the submission categories.
 *
 * @param {Page} mainReviewsPage Page of the submissions categories (myHome on precision conference).
 * @return {Promise<[{ name, link, address, row }]>} A promise that resolves with an array with the submission categories.
 */
const fetchSubmissionCategories = mainReviewsPage =>
  // Fetch all the links to review categories (e.g. conferences). We look for links to avoid selecting the empty tds.
  mainReviewsPage.$$eval('h1 + div table td a', links =>
    Array.from(links)
      // Query their properties.
      .map(link => ({
        name: link.parentNode.parentNode.querySelector('td').innerText,
        address: link.href,
      })),
  );

/**
 * Fetch the submissions of a submission category.
 *
 * @param {Browser} submissionsPage The submission pages.
 * @return {Promise<[{ status, id, paperName }]>} A promise that resolves with an array with the submission.
 */
const fetchSubmissionList = submissionsPage =>
  submissionsPage.$$eval('h1 + blockquote table tr:nth-child(n + 4)', trs =>
    // Fetch the table row of each submission.
    Array.from(trs)
      // Query their properties.
      .map(tr => {
        const tds = tr.querySelectorAll('td');
        return {
          id: tds[6].innerText,
          title: tds[8].querySelector('a').title,
          address: tds[12].querySelector('a').href,
        };
      }),
  );

(async () => {
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
  const categories = await fetchSubmissionCategories(page);
  log.info(
    `Found ${categories.length} review ${pluralize(
      'category',
      categories.length,
    )}: ${categories.map(c => c.name).join(', ')}.`,
  );

  // Fetch the submissions of each submission categhories
  log.info('Scrap reviews...');
  const categoriesData = await Promise.all(
    categories.map(async cat => {
      const catPage = await browser.newPage();
      await catPage.goto(cat.address, {
        waitUntil: 'domcontentloaded',
      });
      const submissions = await fetchSubmissionList(catPage);
      return Object.assign({}, cat, { submissions });
    }),
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
        categories: categoriesData,
      },
      null,
      2,
    ),
  );
  log.info(`Data written in ${OUTPUT_FILE}.`);

  // Clean up.
  await browser.close();
})().catch(e => {
  log.error(e);
  process.exit(0);
});
