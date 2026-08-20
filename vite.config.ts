import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * Dev-only: lets the running page POST a rendered frame to disk so it can be
 * inspected outside the browser. Never registered in a production build.
 */
function devScreenshot(): Plugin {
  return {
    name: 'dev-screenshot',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__shot', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('POST only');
          return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          try {
            const body = Buffer.concat(chunks).toString('utf8');
            const match = /^data:image\/(png|jpeg);base64,([\s\S]*)$/.exec(body.trim());
            if (!match) {
              res.statusCode = 400;
              res.end('expected a data URL body');
              return;
            }
            const name = (req.headers['x-shot-name'] as string | undefined) ?? 'latest';
            const safe = name.replace(/[^a-z0-9_-]/gi, '');
            const out = resolve(process.cwd(), '.dev-shots', `${safe || 'latest'}.${match[1] === 'jpeg' ? 'jpg' : 'png'}`);
            mkdirSync(dirname(out), { recursive: true });
            writeFileSync(out, Buffer.from(match[2], 'base64'));
            res.end(out);
          } catch (err) {
            res.statusCode = 500;
            res.end(String(err));
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [devScreenshot()],
  server: { port: 7443, strictPort: true },
  preview: { port: 7443, strictPort: true },
  build: { target: 'es2022' },
});
