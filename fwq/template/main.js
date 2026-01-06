const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;

function createWindow() {
  // Try to read config
  let config = { title: "FluxPlayer" };
  try {
      const configPath = path.join(__dirname, 'app-config.json');
      if (fs.existsSync(configPath)) {
          config = JSON.parse(fs.readFileSync(configPath));
      }
  } catch(e) {}

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    title: config.title,
    backgroundColor: '#0f172a',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  // Remove menu for immersive feel
  mainWindow.setMenuBarVisibility(false);

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});