import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = await realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const port = Number(process.env.PORT || 4174);
const publicFiles = new Set(['index.js', 'style.css', 'test/browser/fixture.html']);
const types = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
};

function isPublic(relative) {
    const normalized = relative.split(path.sep).join('/');
    return !normalized.split('/').some(part => !part || part.startsWith('.'))
        && (publicFiles.has(normalized) || /^src\/.+\.js$/.test(normalized));
}

const server = createServer(async (request, response) => {
    let pathname;
    try {
        pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    } catch {
        response.writeHead(400).end('Bad request');
        return;
    }
    const relative = pathname === '/' ? 'test/browser/fixture.html' : pathname.slice(1);
    if (pathname.includes('\\') || !isPublic(relative)) {
        response.writeHead(403).end('Forbidden');
        return;
    }
    try {
        const target = await realpath(path.resolve(root, relative));
        if (!target.startsWith(`${root}${path.sep}`) || !isPublic(path.relative(root, target))) {
            response.writeHead(403).end('Forbidden');
            return;
        }
        if (!(await stat(target)).isFile()) {
            throw new Error('Not a file');
        }
        response.writeHead(200, {
            'Content-Type': types[path.extname(target)] ?? 'application/octet-stream',
            'Cache-Control': 'no-store',
        });
        createReadStream(target).on('error', () => response.destroy()).pipe(response);
    } catch {
        response.writeHead(404).end('Not found');
    }
});

server.listen(port, '127.0.0.1', () => {
    console.log(`Test server listening on http://127.0.0.1:${server.address().port}`);
});
