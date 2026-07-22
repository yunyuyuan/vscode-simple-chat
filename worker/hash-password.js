// Usage: node hash-password.js <your-password>
// Store the printed hash as a Cloudflare secret: npx wrangler secret put PASSWORD_HASH
// For local development put it in a .dev.vars file (never commit it): PASSWORD_HASH=<hash>
const crypto = require('crypto');

const SALT = 'cloudchat-v1:'; // must match the SALT in src/index.js
const pwd = process.argv[2];
if (!pwd) {
  console.error('Usage: node hash-password.js <your-password>');
  process.exit(1);
}
console.log(crypto.createHash('sha256').update(SALT + pwd).digest('hex'));
