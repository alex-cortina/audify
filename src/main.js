const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const AUDIO_FILTERS = [
  { name: 'Audio & Video', extensions: ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac', 'webm', 'opus', 'aiff', 'aif', 'mp4', 'm4v', 'mov', 'mkv'] },
  { name: 'Audio', extensions: ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac', 'webm', 'opus', 'aiff', 'aif'] },
  { name: 'Video (audio is extracted)', extensions: ['mp4', 'm4v', 'mov', 'mkv', 'webm'] },
  { name: 'All Files', extensions: ['*'] },
];

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 760,
    minWidth: 800,
    minHeight: 480,
    backgroundColor: '#121418',
    title: 'Audify',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'index.html'));

  // Open a file passed on the command line: `npm start -- song.wav`
  const argFile = process.argv.slice(app.isPackaged ? 1 : 2).find(a => !a.startsWith('-') && fs.existsSync(a));
  if (argFile) {
    win.webContents.once('did-finish-load', () => {
      win.webContents.send('open-path', path.resolve(argFile));
    });
  }
}

ipcMain.handle('dialog:open', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const res = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: AUDIO_FILTERS });
  if (res.canceled || res.filePaths.length === 0) return null;
  const filePath = res.filePaths[0];
  const data = fs.readFileSync(filePath);
  return { path: filePath, name: path.basename(filePath), data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
});

ipcMain.handle('file:read', async (event, filePath) => {
  const data = fs.readFileSync(filePath);
  return { path: filePath, name: path.basename(filePath), data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
});

ipcMain.handle('dialog:save', async (event, { defaultName, data }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const res = await dialog.showSaveDialog(win, {
    defaultPath: defaultName,
    filters: /\.mp3$/i.test(defaultName) ? [{ name: 'MP3 Audio', extensions: ['mp3'] }] : [{ name: 'WAV Audio', extensions: ['wav'] }],
  });
  if (res.canceled || !res.filePath) return null;
  fs.writeFileSync(res.filePath, Buffer.from(data));
  return res.filePath;
});

ipcMain.handle('window:setTitle', (event, title) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.setTitle(title);
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
