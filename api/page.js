const fs = require('fs');
const path = require('path');

module.exports = (req, res) => {
  const file = path.join(process.cwd(), 'public', 'index.html');
  fs.readFile(file, 'utf8', (error, html) => {
    if (error) {
      res.statusCode = 500;
      res.end('Não foi possível carregar a página.');
      return;
    }

    const script = '<script src="/voice-manager.js" defer></script>';
    const page = html.includes('/voice-manager.js')
      ? html
      : html.replace('</body>', `${script}</body>`);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(page);
  });
};
