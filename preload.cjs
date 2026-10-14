const { contextBridge, ipcRenderer } = require('electron');

const methods = ['library', 'document', 'import', 'sample', 'settings', 'saveSettings',
  'testConnection', 'setTheme', 'copyText', 'parse', 'translate', 'startReading', 'enqueueReading', 'pause', 'clearTranslations', 'edit', 'export', 'deleteDocument', 'renameDocument', 'documentFolder', 'documentMenu', 'original', 'dataFolder', 'external'];
contextBridge.exposeInMainWorld('paperbridge', {
  ...Object.fromEntries(methods.map(method => [method, (...args) => ipcRenderer.invoke(method, ...args)])),
  onUpdate: callback => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('update', listener);
    return () => ipcRenderer.removeListener('update', listener);
  },
});
