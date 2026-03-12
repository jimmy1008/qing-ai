const { getThreadsContext, closeThreadsContext } = require("./browser_manager");

async function launchBrowser() {
  return getThreadsContext();
}

async function closeBrowser() {
  return closeThreadsContext();
}

module.exports = {
  launchBrowser,
  closeBrowser,
};
