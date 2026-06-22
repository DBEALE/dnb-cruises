const { chromium } = require('@playwright/test');
const { spawn } = require('child_process');
const path = require('path');

async function run() {
  const port = 3000;
  console.log(`Starting server on port ${port}...`);
  
  // Spawn the server process
  const serverProcess = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: port },
    stdio: 'inherit',
    shell: true
  });
  
  // Wait for 3 seconds to let the server start up
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  console.log('Launching browser...');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  // Set viewport to a nice desktop size
  await page.setViewportSize({ width: 1280, height: 800 });
  
  console.log(`Navigating to http://localhost:${port}...`);
  await page.goto(`http://localhost:${port}`);
  
  // Wait for the UI to load and render content (e.g. title wave, table)
  await page.waitForTimeout(2000);
  
  const screenshotPath = path.join(__dirname, '../docs/screenshots/service-running.png');
  console.log(`Saving screenshot to: ${screenshotPath}`);
  await page.screenshot({ path: screenshotPath, fullPage: false });
  
  console.log('Closing browser...');
  await browser.close();
  
  console.log('Stopping server...');
  if (process.platform === 'win32') {
    // Gracefully kill the process tree on Windows
    spawn('taskkill', ['/pid', serverProcess.pid, '/f', '/t']);
  } else {
    serverProcess.kill('SIGTERM');
  }
  
  console.log('Screenshot script complete!');
}

run().catch(err => {
  console.error('Error during screenshot capture:', err);
  process.exit(1);
});
