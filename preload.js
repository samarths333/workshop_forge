'use strict';
const { contextBridge, ipcRenderer } = require('electron');

/* The whole renderer surface. Nothing here hands the renderer a file path,
   a key or a socket — it asks main to do a named thing and gets plain JSON
   back, which is why contextIsolation can stay on and nodeIntegration off. */
contextBridge.exposeInMainWorld('forge', {
  plan:    (messages, schema) => ipcRenderer.invoke('llm:plan', { messages, schema }),
  probe:   ()                 => ipcRenderer.invoke('llm:probe'),
  getCfg:  ()                 => ipcRenderer.invoke('cfg:get'),
  setCfg:  (c)                => ipcRenderer.invoke('cfg:set', c),
  openUrl: (u)                => ipcRenderer.invoke('shell:open', u),
  refs:    (term)             => ipcRenderer.invoke('refs:search', term),

  skills: {
    load:   ()     => ipcRenderer.invoke('skills:load'),
    save:   (list) => ipcRenderer.invoke('skills:save', list),
    where:  ()     => ipcRenderer.invoke('skills:path'),
    export: ()     => ipcRenderer.invoke('skills:export'),
    import: ()     => ipcRenderer.invoke('skills:import')
  }
});
