/**
 * HTTPS agent for the internal hops (TARGET_URL: bg-rpc-proxy on 48544, its
 * /getlogsStatus, and the getLogs forwarding path).
 *
 * Certificates are verified. Today every target presents a public (Let's Encrypt)
 * certificate, so Node's default roots are enough. If a target ever presents a
 * private certificate, put its PEM (or its CA's) in a file and set TARGET_CA_FILE
 * to that path: it is added to the trusted roots for this agent only. Nothing else
 * in the process (Telegram, Firebase, the fallback provider) is affected either way.
 */

import https from 'https';
import fs from 'fs';
import tls from 'tls';

function trustedCa() {
  const file = process.env.TARGET_CA_FILE;
  if (!file) return undefined;
  try {
    const pem = fs.readFileSync(file, 'utf8');
    console.log(`🔐 Internal agent: trusting extra CA from ${file}`);
    return [...tls.rootCertificates, pem];
  } catch (err) {
    console.error(`⚠️  TARGET_CA_FILE "${file}" could not be read (${err.message}); using default roots only`);
    return undefined;
  }
}

const internalAgent = new https.Agent({
  keepAlive: true,
  rejectUnauthorized: true,
  ca: trustedCa()
});

export { internalAgent };
