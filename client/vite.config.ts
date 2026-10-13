import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { resolveSignalingConfig } from './src/lib/config';

export default defineConfig(({ command, mode }) => {
  let signalingUrl: string | undefined;
  if (command === 'build') {
    const config = resolveSignalingConfig(loadEnv(mode, '..', 'VITE_').VITE_SIGNALING_URL, false);
    if (!config.ok) throw new Error(config.error);
    signalingUrl = config.url;
  }
  return {
    envDir: '..',
    // Even `NODE_ENV=development vite build` must keep packaged clients strict.
    ...(command === 'build' ? { define: { 'import.meta.env.DEV': 'false' } } : {}),
    plugins: [react(), {
      name: 'talkie-public-build-info',
      generateBundle() {
        if (signalingUrl) this.emitFile({ type: 'asset', fileName: 'talkie-build.json', source: JSON.stringify({ schemaVersion: 1, signalingUrl, configuration: 'build-time' }, null, 2) });
      },
    }],
    clearScreen: false,
    server: { port: 5173, strictPort: true }
  };
});
