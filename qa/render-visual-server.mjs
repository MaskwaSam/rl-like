// Local-only deterministic renderer comparison; no game login or production services.
import { createServer, transformWithOxc } from 'vite';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
const baseline = '29cebbaf055d7e8bdd010c0e975a31afad19c527';
const ids = new Map(['renderer','effects'].map(name => [`\0visual-baseline/${name}.ts`, name]));
const evidence = resolve('.qa-build/render-visual');
await mkdir(evidence, { recursive: true });
const server = await createServer({ configFile: false, server: { host: '127.0.0.1', port: 5189, strictPort: true }, plugins: [{
  name: 'visual-baseline', enforce: 'pre',
  resolveId(source, importer) {
    if (source.startsWith('visual-baseline/')) return '\0' + source + '.ts';
    if (ids.has(importer)) {
      if (source === './effects') return '\0visual-baseline/effects.ts';
      return this.resolve(source.startsWith('.') ? resolve('src/render', source) : source, resolve('src/render/renderer.ts'), { skipSelf: true });
    }
  },
  async load(id) { if (ids.has(id)) return (await transformWithOxc(execFileSync('git', ['show', `${baseline}:src/render/${ids.get(id)}.ts`], { encoding: 'utf8' }), `${ids.get(id)}.ts`)).code; },
  configureServer(s) {
    s.middlewares.use('/__visual_evidence', async (req, res) => {
      try {
        if (req.method !== 'POST' || req.headers.origin !== 'http://127.0.0.1:5189') { res.statusCode=403; res.end(); return; }
        let body=''; for await (const chunk of req) { body += chunk; if(body.length > 12_000_000) throw Error('Too large'); }
        const { name, images, report } = JSON.parse(body);
        if (!/^[a-z0-9-]{1,80}$/.test(name)) throw Error('Bad name');
        for (const key of ['baseline','candidate']) {
          if (!/^data:image\/png;base64,/.test(images[key])) throw Error('Bad image');
          await writeFile(resolve(evidence, `${name}-${key}.png`), Buffer.from(images[key].split(',')[1], 'base64'));
        }
        await writeFile(resolve(evidence, `${name}.json`), JSON.stringify(report,null,2)+'\n');
        res.end('ok');
      } catch(e) { res.statusCode=400; res.end(String(e)); }
    });
  },
}] });
await server.listen();
console.log('Visual QA: http://127.0.0.1:5189/qa/render-visual.html');
