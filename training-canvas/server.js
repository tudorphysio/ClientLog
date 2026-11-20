'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const port = Number(process.env.PORT) || 8080;
const page = path.join(__dirname, 'index.html');
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;
  if (pathname === '/health') {
    res.writeHead(200, {'content-type':'text/plain; charset=utf-8'});
    return res.end('ok');
  }
  if (pathname !== '/' && pathname !== '/index.html') {
    res.writeHead(404, {'content-type':'text/plain; charset=utf-8'});
    return res.end('Not found');
  }
  fs.readFile(page, (err, html) => {
    if (err) {
      res.writeHead(500, {'content-type':'text/plain; charset=utf-8'});
      return res.end('Unable to load canvas');
    }
    res.writeHead(200, {
      'content-type':'text/html; charset=utf-8',
      'cache-control':'no-store',
      'x-content-type-options':'nosniff',
      'x-frame-options':'DENY'
    });
    res.end(html);
  });
});
server.listen(port, '0.0.0.0', () => console.log('Training Canvas listening on ' + port));
