const express = require('express');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// Store job status in memory
const jobs = {};

// Ensure directories exist
const TEMP_DIR = path.join(__dirname, 'temp_workspace');
fs.ensureDirSync(TEMP_DIR);

/**
 * Utility: Run a shell command and stream output to job logs
 */
function runCommand(command, args, cwd, jobId) {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32';
    
    let cmd = command;
    let spawnArgs = args;

    // Fix for EINVAL and DEP0190 on Windows
    // We explicitly invoke cmd.exe to run npm/batch files when shell: false
    if (isWin && command === 'npm') {
        cmd = 'cmd.exe';
        spawnArgs = ['/c', 'npm', ...args];
    }

    console.log(`[${jobId}] Spawning: ${cmd} ${spawnArgs.join(' ')}`);

    // --- MIRROR CONFIGURATION ---
    // Inject environment variables to force download from domestic mirrors (npmmirror)
    // This solves the slow GitHub download issue.
    const buildEnv = {
        ...process.env,
        // Mirror for the main Electron binary (100MB+) - KEEP THIS for speed
        ELECTRON_MIRROR: "https://npmmirror.com/mirrors/electron/",
        
        // REMOVED: ELECTRON_BUILDER_BINARIES_MIRROR 
        // Reason: The mirror sometimes serves archives that cause "Cannot create symbolic link" 
        // errors on Windows non-admin environments (winCodeSign issues). 
        // These tools are small (~5MB) so GitHub download is usually acceptable and safer.
    };

    // shell: false prevents the security warning and improves safety
    const child = spawn(cmd, spawnArgs, { 
        cwd, 
        shell: false,
        env: buildEnv // Pass the modified environment
    });

    child.stdout.on('data', (data) => {
      const line = data.toString().trim();
      if (line) {
        console.log(`[${jobId}] ${line}`);
        if(jobs[jobId]) jobs[jobId].logs.push(line);
      }
    });

    child.stderr.on('data', (data) => {
      const line = data.toString().trim();
      if (line) {
        console.error(`[${jobId} STDERR] ${line}`);
        // Filter npm noise, preserve real errors
        if(jobs[jobId]) {
             if (line.toLowerCase().includes('error') || line.toLowerCase().includes('fail')) {
                 jobs[jobId].logs.push(`ERR: ${line}`);
                 
                 // Smart Error Detection for Users
                 if (line.includes('Cannot create symbolic link')) {
                     jobs[jobId].logs.push(`> ⚠️ HINT: This is a Windows permission issue.`);
                     jobs[jobId].logs.push(`> ⚠️ TRY: Run your terminal/command prompt as Administrator.`);
                 }
             } else {
                 // Log info/warnings without error prefix
                 jobs[jobId].logs.push(`> ${line}`);
             }
        }
      }
    });

    child.on('error', (err) => {
        console.error(`[${jobId} SPAWN ERROR]`, err);
        if(jobs[jobId]) jobs[jobId].logs.push(`SPAWN ERROR: ${err.message}`);
        reject(err);
    });

    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command failed with exit code ${code}`));
    });
  });
}

/**
 * API: Start Build
 */
app.post('/api/build', async (req, res) => {
  const { platform, config } = req.body;
  const jobId = uuidv4();
  const jobDir = path.join(TEMP_DIR, jobId);

  jobs[jobId] = {
    id: jobId,
    status: 'initializing',
    progress: 0,
    logs: ['> Job initialized...'],
    filePath: null
  };

  res.json({ jobId });

  // Async Build Process
  (async () => {
    try {
      const job = jobs[jobId];
      
      // 1. Setup Workspace
      job.status = 'building';
      job.progress = 5;
      job.logs.push(`> Creating workspace: ${jobDir}`);
      
      const templatePath = path.join(__dirname, 'template');
      
      if (!fs.existsSync(templatePath)) {
        throw new Error("Template folder missing! Please ensure 'fwq/template' exists.");
      }

      await fs.copy(templatePath, jobDir);
      
      // Inject Data (Crucial Step: Convert JSON config to a JS file the template can load easily)
      const dataScriptContent = `window.APP_DATA = ${JSON.stringify(config)};`;
      await fs.ensureDir(path.join(jobDir, 'src')); // Ensure src exists
      await fs.writeFile(path.join(jobDir, 'src', 'data.js'), dataScriptContent);

      job.logs.push('> App Data injected into build source.');
      job.progress = 10;

      // 2. Install Dependencies
      job.logs.push('> Installing dependencies...');
      
      // Run npm install
      await runCommand('npm', ['install', '--loglevel=error'], jobDir, jobId);
      
      job.progress = 40;
      job.logs.push('> Dependencies installed.');

      // 3. Build & Package
      job.logs.push(`> Starting Electron build for ${platform}...`);
      
      // Map platform to electron-builder targets
      let buildArgs = ['run', 'build'];
      if (platform.includes('Windows')) buildArgs = ['run', 'build:win'];
      if (platform.includes('Mac') || platform.includes('iOS')) buildArgs = ['run', 'build:mac'];
      if (platform.includes('Android') || platform.includes('Linux')) buildArgs = ['run', 'build:linux'];

      await runCommand('npm', buildArgs, jobDir, jobId);

      job.progress = 90;
      job.logs.push('> Packaging complete.');

      // 4. Locate Artifact
      const distDir = path.join(jobDir, 'dist');
      // Ensure dist exists before reading (build might fail before creating it)
      if (await fs.pathExists(distDir)) {
          const files = await fs.readdir(distDir);
          
          // Find the executable
          const artifact = files.find(f => f.endsWith('.exe') || f.endsWith('.dmg') || f.endsWith('.AppImage') || f.endsWith('.zip'));

          if (!artifact) {
            throw new Error("Build finished but no artifact found in dist folder.");
          }

          job.filePath = path.join(distDir, artifact);
          job.logs.push(`> Artifact ready: ${artifact}`);
          job.progress = 100;
          job.status = 'completed';
      } else {
           throw new Error("Dist folder not found. Build likely failed.");
      }

    } catch (err) {
      console.error(`Job ${jobId} failed:`, err);
      if (jobs[jobId]) {
        jobs[jobId].status = 'error';
        jobs[jobId].logs.push(`> BUILD FAILED: ${err.message}`);
      }
    }
  })();
});

/**
 * API: Get Status
 */
app.get('/api/job/:id', (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

/**
 * API: Download
 */
app.get('/api/download/:id', (req, res) => {
  const job = jobs[req.params.id];
  if (job && job.status === 'completed' && job.filePath) {
    res.download(job.filePath);
  } else {
    res.status(404).send('File not ready or job not found');
  }
});

app.listen(PORT, () => {
  console.log(`Real Build Server (fwq) running on http://localhost:${PORT}`);
  console.log(`Ready to build Electron apps.`);
});