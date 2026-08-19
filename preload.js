'use strict';
const { contextBridge, ipcRenderer } = require('electron');

/* The whole renderer surface. Nothing here hands the renderer a file path,
   a key or a socket — it asks main to do a named thing and gets plain JSON
   back, which is why contextIsolation can stay on and nodeIntegration off. */
contextBridge.exposeInMainWorld('forge', {
  /* `role` is who on the floor is asking. Main routes it to a TIER, and the
     tier picks the engine — your best model writes the work order, a fast
     cheap one answers the four specialist briefs. */
  plan:    (messages, schema, role) => ipcRenderer.invoke('llm:plan', { messages, schema, role }),
  probe:   ()                 => ipcRenderer.invoke('llm:probe'),
  models:  (provider)         => ipcRenderer.invoke('llm:models', { provider }),
  getCfg:  ()                 => ipcRenderer.invoke('cfg:get'),
  setCfg:  (c)                => ipcRenderer.invoke('cfg:set', c),
  openUrl: (u)                => ipcRenderer.invoke('shell:open', u),
  refs:    (term)             => ipcRenderer.invoke('refs:search', term),
  read:    (urls)             => ipcRenderer.invoke('refs:read', urls),

  /* The CAD kernel. `cadRun` executes a script that has ALREADY been
     through gateScript — the renderer is not trusted to skip that, which
     is why kernel.py checks the text again on the other side. */
  cadProbe: ()                => ipcRenderer.invoke('cad:probe'),
  cadRun:   (code, opts)      => ipcRenderer.invoke('cad:run', { code, ...(opts || {}) }),

  /* The headless side. Only ever reachable from forge.html, which is only
     ever loaded when the app was started with --forge. */
  forgeJob:  ()      => ipcRenderer.invoke('forge:job'),
  forgeLog:  (msg)   => ipcRenderer.send('forge:log', msg),
  forgeDone: (result) => ipcRenderer.send('forge:done', result),
  saveModel: (payload)        => ipcRenderer.invoke('model:save', payload),

  /* Shapes somebody made. Same three calls as skills and no more — the
     renderer owns what a shape IS, main owns the file. */
  shapes: {
    load:  ()     => ipcRenderer.invoke('shapes:load'),
    save:  (list) => ipcRenderer.invoke('shapes:save', list),
    where: ()     => ipcRenderer.invoke('shapes:path')
  },

  skills: {
    load:   ()     => ipcRenderer.invoke('skills:load'),
    save:   (list) => ipcRenderer.invoke('skills:save', list),
    where:  ()     => ipcRenderer.invoke('skills:path'),
    export: ()     => ipcRenderer.invoke('skills:export'),
    import: ()     => ipcRenderer.invoke('skills:import')
  }
});
