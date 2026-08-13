/**
 * Force Monaco to load from the LOCALLY installed `monaco-editor` package
 * (bundled by Vite) instead of fetching it from the jsDelivr CDN at runtime.
 *
 * Why: `@monaco-editor/react` defaults to loading Monaco from a CDN. That
 * caused the SQL editor's autocomplete options/providers to be unreliable
 * (the CDN bundle is a separate build from the package we develop against),
 * and made the app depend on network access just to render the editor.
 * Configuring the loader with our own imported `monaco` makes Vite bundle it.
 *
 * This module also wires up Monaco's web workers via Vite's `?worker` import
 * so syntax tokenization / validation runs off the main thread. Import this
 * once, early (before any <Editor> mounts).
 */
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';

import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';

// Vite resolves `?worker` to a worker constructor. Monaco expects a function
// that returns a Worker instance via `self.MonacoEnvironment.getWorker`.
self.MonacoEnvironment = {
  getWorker() {
    return new editorWorker();
  },
};

// Point the loader at our bundled Monaco so no CDN fetch happens.
loader.config({ monaco });

export { monaco };
