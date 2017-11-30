const puppeteer = require('puppeteer');
const log = require('loglevel');
const pluralize = require('pluralize');
const { promisify } = require('util');
const fs = require('fs');

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
 * @return {Promise<[{ name, link, address, row  }]>} A promise that resolves with an array with the submission categories.
 */
const fetchSubmissionCategories = async mainReviewsPage => {
  // Fetch all the links to review categories (e.g. conferences).
  // We look for links to avoid selecting the empty tds.
  const links = await mainReviewsPage.$$('h1 + div table td a');

  // From the link, fetch all useful properties.
  const cats = links.map(async link => {
    const row = await link
      .getProperty('parentNode')
      .then(linkTd => linkTd.getProperty('parentNode'));
    return {
      name: await row
        .$('td')
        .then(el => el.getProperty('innerText'))
        .then(prop => prop.jsonValue()),
      address: await link.getProperty('href').then(prop => prop.jsonValue()),
    };
  });
  return Promise.all(cats);
};

/**
 * Fetch the submissions of a submission category.
 *
 * @param {Browser} submissionsPage The submission pages.
 * @return {Promise<[{ status, id, paperName }]>} A promise that resolves with an array with the submission.
 */
const fetchSubmissionList = async submissionsPage => {
  const submissionTrList = await submissionsPage.$$(
    'h1 + blockquote table tr:nth-child(n + 4)',
  );
  const submissions = submissionTrList.map(async tr => {
    const tds = await tr.$$('td');
    return {
      id: await tds[6].getProperty('innerText').then(prop => prop.jsonValue()),
      title: await tds[8]
        .$('a')
        .then(a => a.getProperty('title'))
        .then(prop => prop.jsonValue()),
      address: await tds[12]
        .$('a')
        .then(a => a.getProperty('href'))
        .then(prop => prop.jsonValue()),
    };
  });
  return Promise.all(submissions);
};

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
  const data = await Promise.all(
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
  await writeFile(OUTPUT_FILE, JSON.stringify(data, null, 2));
  log.info(`Data written in ${OUTPUT_FILE}.`);

  // Clean up.
  await browser.close();
})().catch(e => {
  log.error(e);
  process.exit(0);
});
