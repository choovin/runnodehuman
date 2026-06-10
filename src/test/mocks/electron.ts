import path from 'path';

const noop = () => undefined;
const asyncNoop = async () => undefined;

export const app = {
  isPackaged: false,
  commandLine: {
    appendSwitch: noop,
  },
  getAppPath: () => process.cwd(),
  getName: () => 'WeSight',
  getPath: (name: string) => path.join(process.cwd(), '.tmp', name),
  getVersion: () => '0.0.0-test',
  isReady: () => true,
  on: noop,
  once: noop,
  quit: noop,
  relaunch: noop,
  requestSingleInstanceLock: () => true,
  setAppUserModelId: noop,
  whenReady: async () => undefined,
};

export class BrowserWindow {
  static fromWebContents() {
    return null;
  }

  static getAllWindows() {
    return [];
  }

  loadURL = asyncNoop;
  on = noop;
  once = noop;
  show = noop;
  focus = noop;
  close = noop;
  destroy = noop;
  isDestroyed = () => false;
  webContents = {
    on: noop,
    send: noop,
  };
}

export const clipboard = {
  readText: () => '',
  writeText: noop,
};

export const contextBridge = {
  exposeInMainWorld: noop,
};

export const dialog = {
  showErrorBox: noop,
  showMessageBox: async () => ({ response: 0 }),
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
};

export const ipcMain = {
  handle: noop,
  on: noop,
  removeHandler: noop,
};

export const ipcRenderer = {
  invoke: asyncNoop,
  on: noop,
  removeListener: noop,
  send: noop,
};

export const Menu = {
  buildFromTemplate: () => ({}),
  setApplicationMenu: noop,
};

export const nativeImage = {
  createFromBuffer: () => ({}),
  createFromDataURL: () => ({}),
  createFromPath: () => ({}),
};

export const nativeTheme = {
  shouldUseDarkColors: false,
  themeSource: 'system',
  on: noop,
};

export const net = {
  fetch: globalThis.fetch,
};

export const powerMonitor = {
  on: noop,
};

export const powerSaveBlocker = {
  start: () => 1,
  stop: noop,
};

export const protocol = {
  handle: noop,
  registerFileProtocol: noop,
};

export const screen = {
  getPrimaryDisplay: () => ({
    workAreaSize: { width: 1440, height: 900 },
  }),
};

export const session = {
  defaultSession: {
    clearCache: asyncNoop,
    clearStorageData: asyncNoop,
    cookies: {
      get: async () => [],
      set: asyncNoop,
    },
    webRequest: {
      onBeforeRequest: noop,
      onBeforeSendHeaders: noop,
    },
  },
};

export const shell = {
  openExternal: asyncNoop,
  openPath: async () => '',
  showItemInFolder: noop,
};

export class Tray {
  destroy = noop;
  on = noop;
  setContextMenu = noop;
  setToolTip = noop;
}

export type IpcRendererEvent = unknown;
export type WebContents = unknown;
