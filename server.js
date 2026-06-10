const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('fluent-ffmpeg');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());

const port = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '';

function checkApiKey(req, res, next) {
  if (!API_KEY) {
    return res.status(500).json({ error: 'API_KEY no configurada en el servidor.' });
  }
  if (req.get('X-API-Key') !== API_KEY) {
    return res.status(401).json({ error: 'API key inválida o ausente.' });
  }
  next();
}

function launchOptions() {
  const options = {
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    options.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  return options;
}

app.get('/health', async (req, res) => {
  const status = { server: 'ok', puppeteer: 'unknown', ffmpeg: 'ok' };
  try {
    const browser = await puppeteer.launch(launchOptions());
    await browser.close();
    status.puppeteer = 'ok';
  } catch (err) {
    status.puppeteer = `error: ${err.message}`;
  }
  const allOk = status.puppeteer === 'ok';
  res.status(allOk ? 200 : 500).json(status);
});

app.post('/render-html-to-mp4', checkApiKey, async (req, res) => {
  const { url } = req.body || {};
  if (!url) {
    return res.status(400).json({ error: 'Falta el campo "url" con la dirección del HTML a renderizar.' });
  }

  const tmpDir = os.tmpdir();
  const screenshotPath = path.join(tmpDir, `frame-${uuidv4()}.png`);
  const outputPath = path.join(tmpDir, `video-${uuidv4()}.mp4`);

  let browser;
  try {
    browser = await puppeteer.launch(launchOptions());
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await browser.close();
    browser = null;

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(screenshotPath)
        .loop(10)
        .outputOptions([
          '-pix_fmt yuv420p',
          '-c:v libx264',
          '-crf 18',
          '-preset slow',
          '-t 10',
          '-vf scale=1920:1080'
        ])
        .save(outputPath)
        .on('end', resolve)
        .on('error', reject);
    });

    res.setHeader('Content-Type', 'video/mp4');
    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on('close', () => {
      fs.unlink(screenshotPath, () => {});
      fs.unlink(outputPath, () => {});
    });
  } catch (error) {
    if (browser) await browser.close();
    if (fs.existsSync(screenshotPath)) fs.unlinkSync(screenshotPath);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, () => {
  console.log(`🚀 Render converter escuchando en puerto ${port}`);
});
