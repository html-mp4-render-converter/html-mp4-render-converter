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

const jobs = new Map();

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

app.post('/render-html-to-mp4', checkApiKey, (req, res) => {
  const { url } = req.body || {};
  if (!url) {
    return res.status(400).json({ error: 'Falta el campo "url" con la dirección del HTML a renderizar.' });
  }

  const jobId = uuidv4();
  jobs.set(jobId, { status: 'processing', percent: 0, error: null, filePath: null });
  res.json({ jobId });

  processJob(jobId, url);
});

async function processJob(jobId, url) {
  const job = jobs.get(jobId);
  const tmpDir = os.tmpdir();
  const screenshotPath = path.join(tmpDir, `frame-${jobId}.png`);
  const outputPath = path.join(tmpDir, `video-${jobId}.mp4`);

  let browser;
  try {
    job.percent = 5;
    browser = await puppeteer.launch(launchOptions());
    job.percent = 15;
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    job.percent = 25;
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
    job.percent = 45;
    await page.screenshot({ path: screenshotPath, fullPage: true });
    job.percent = 60;
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
        .on('progress', p => {
          const stagePercent = Math.min(100, Math.max(0, p.percent || 0));
          job.percent = Math.min(99, 60 + Math.round(stagePercent * 0.39));
        })
        .save(outputPath)
        .on('end', resolve)
        .on('error', reject);
    });

    job.status = 'done';
    job.percent = 100;
    job.filePath = outputPath;
    job.screenshotPath = screenshotPath;
  } catch (error) {
    if (browser) {
      try { await browser.close(); } catch (e) { /* ignore */ }
    }
    if (fs.existsSync(screenshotPath)) fs.unlinkSync(screenshotPath);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    job.status = 'error';
    job.error = error.message;
  }
}

app.get('/job/:id', checkApiKey, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Job no encontrado.' });
  }
  res.json({ status: job.status, percent: job.percent, error: job.error });
});

app.get('/job/:id/file', checkApiKey, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'done' || !job.filePath || !fs.existsSync(job.filePath)) {
    return res.status(404).json({ error: 'El video aún no está disponible.' });
  }
  res.setHeader('Content-Type', 'video/mp4');
  const stream = fs.createReadStream(job.filePath);
  stream.pipe(res);
  stream.on('close', () => {
    fs.unlink(job.filePath, () => {});
    if (job.screenshotPath && fs.existsSync(job.screenshotPath)) {
      fs.unlink(job.screenshotPath, () => {});
    }
    jobs.delete(req.params.id);
  });
});

app.listen(port, () => {
  console.log(`🚀 Render converter escuchando en puerto ${port}`);
});
